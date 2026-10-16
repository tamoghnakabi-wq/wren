# Wren: handoff notes for Claude Code

Wren is a personal AI agent platform (Dots / Grok-Bot style). Agents do real work on their own cloud computer (a Vercel Sandbox VM) or on the user's Mac/PC (desktop app). The user starts tasks from any device, watches each step live, approves sensitive actions and gets the results.

State as of 2026-10-16: the re-audit #26 fix (W-185 marker reads) is desktop **0.1.33**, not yet committed or released; production runs desktop 0.1.32 (`c0e887a`; the latest migration is `wren_0014_external_cleanups`, repo 0012; this round has none). Update this line when 0.1.33 ships. Wren credits are switched off for every account (`70afa23`, see Models). The twenty-six Codex security audits (W-1…W-187) are all fixed or, for W-156, documented in Known limitations; see "Audit history" (W-79 is a documented Windows residual). No feature work is in progress.

`README.md` is the public overview. `docs/ARCHITECTURE.md` describes the overall design, but parts of it predate later audits; where it disagrees with this file, trust this file and the code (see "Known limitations").

---

## Repository layout (npm workspaces, Node ≥ 22)

```
packages/core     @wren/core: agent runtime shared by cloud and desktop
  src/loop.ts         resumable agent loop (state machine over the event log)
  src/policy.ts       risk assessment: shell lexer (parseShell), isReadOnlyCommand, browser/file/GitHub rules
  src/tools.ts        tool catalog + describeCall
  src/models/         responses.ts (OpenAI Responses: API key, ChatGPT plan, xAI, AI Gateway),
                      anthropic.ts (official SDK), chat.ts (OpenAI-compatible/local), scripted.ts (test model), sse.ts
  src/browser/        controller.ts (Playwright controller, shared) + daemon-source.ts (GENERATED, see below)
  src/net.ts          guardedFetch (SSRF guard, checked at connect time)
  src/prompt.ts, transcript.ts, text.ts, semver.ts, types.ts
  scripts/gen-daemon.mjs   regenerates daemon-source.ts from controller.ts
  test/               vitest: policy, loop, browser (real Chrome, opt-in), responses, chat, net, semver
apps/web          @wren/web: Next.js 16.3.8 (Turbopack), React 19, on Vercel
  src/app/            site (/, /download, /legal, /login, /signup), app (/app/...), API routes (/api/...)
  src/lib/runs.ts     startTask, continueActiveRun, finishRun, cleanUpCloudRun, decideApproval, cancelRun, kickRun/kickTick
  src/lib/runner/     tick.ts (cloud tick), sandbox-host.ts (Vercel Sandbox tool host), store.ts (lease-fenced store)
  src/lib/client/     browser-side helpers: live.ts (useLive), layout.ts (collapsible panes), desktop.ts, api.ts, supabase.ts
  src/components/     ui.tsx (shared UI kit), app/* (shell, timeline, composer, approval-card, ...), agent-character.tsx
apps/desktop      wren-desktop 0.1.33: Electron 44
  src/main/index.ts   app entry (tray, window, IPC, pairing, update install, --selftest)
  src/main/runner.ts  DeviceRunner: heartbeat, realtime wake, claims and runs work (up to 3 at once)
  src/main/host.ts    LocalHost tool host (shell jobs, files, browser, screen), job registry
  src/main/sandbox.ts macOS Seatbelt profiles (shell, file helpers, engines)
  src/main/confined.ts file read/write/list confinement; paths.ts (confinePath); shellenv.ts (toolEnv, absolutePath)
  src/main/proctree.ts killTree/treeAlive (confirmed process-tree termination; Windows: parent-id walk), tracked()
  src/main/jobs.ts    shell job records: kept until the whole tree is confirmed gone (stopAllJobs, killRunJobs)
  src/main/winjob.ts  Windows: each command puts itself in a kill-on-close Job Object (helper DLL built with Add-Type)
  src/main/trust.ts   which bare program names resolve to programs agents can't have written (PATH vs agentWritable)
  src/main/asks.ts    pendingAsks (which user messages a CLI engine still has to get)
  src/main/updater.ts signed self-updater; chatgpt.ts Sign in with ChatGPT; config.ts (dataDir, policy, safeStorage)
  src/engines/        claude-code.ts, grok-build.ts, common.ts (spawn, TimelineWriter, approval bridge), grok-hook.ts, mcp-approve.ts
  scripts/            build.mjs (esbuild -> dist-electron), package.mjs (electron-builder), ui-smoke.mjs
supabase/migrations   0000…0012 (production names: see Deploy and release)
releases/vX.Y.Z.md    release notes used by the release workflow
scripts/              gen-icons.mjs, release-manifest.mjs (signs wren-update.json)
.github/workflows/desktop.yml   desktop build + release on `v*` tags
qa/                   empty
```

`packages/core/src/browser/daemon-source.ts` is **generated**. After any change to `controller.ts`, run `node scripts/gen-daemon.mjs` in `packages/core` and commit both files. The cloud browser VM runs this source with Node type stripping, so `controller.ts` must stay self-contained:
- no relative imports
- erasable TypeScript only (no enums or parameter properties)
- page-side code written as strings

---

## Architecture

### Data and API
- Supabase Postgres holds the data. Browser pages read their rows directly, protected by RLS, and stay live through Realtime `postgres_changes` (`useLive`).
- **All writes go through API routes.** They authenticate the Supabase session or a device token and connect as the `wren_api` role through the pooler (`DATABASE_URL`, postgres.js).
- Secrets tables have no browser policies. API keys are AES-encrypted with `WREN_SECRETS_KEY` and never sent to an agent's computer.
- Files live in a private Vercel Blob store and are served only through `/api/files/[id]` after an ownership check, with `Cache-Control: private, no-store`, so the browser never shows a kept copy without asking again (W-176: after a sign-out, to another account on the same browser).
- Every table the UI reads live must be in the `supabase_realtime` publication.

### A task's life
1. `POST /api/tasks` (`startTask`) appends the user message (with a context block) to `events` and creates a `run` with `runtime = cloud | desktop`. Only one active run is allowed per session (migration 0006).
2. **Cloud runs.** `/api/internal/tick` takes a lease on the run and runs the loop.
   - A tick lasts at most about 235 s (`BUDGET_MS`; model budget 185 s; function `maxDuration` 300) and then hands off to the next tick.
   - pg_cron calls `/api/internal/cron` every minute. That route:
     - re-kicks stalled runs and runs whose retry is due
     - starts due schedules
     - expires approvals
     - retries `cleanup_pending` cloud runs
     - and the backstops below (unclaimed and unlinked computers, removed agents, failed deletions)

     It answers within one 45 s deadline (`DEADLINE_MS`; `maxDuration` 60): each stage, its database queries included, is waited for only until then (`stage`/`inTime`); the stages that are mostly database work run before the provider calls (computers, files); no new work starts once the time is up (loops check `until`, passed down to `revokeDevice`'s task ending too), except claimed schedules and the wake-up of runs whose approval just expired, which nothing would redo. The report lists stages not reached in `skipped` and stages still going at the deadline in `late` (their started work may still finish; it is all scoped to its own task, computer or file and safe to repeat).
3. **Desktop runs.**
   - The server broadcasts a content-free `wake` on the device's own Realtime channel; a 60 s heartbeat is the fallback. It is a public broadcast channel (not RLS-checked) named by a random key only the device and the server know (`device_secrets.channel_key`): send nothing on it but a reason and a time.
   - The device claims the run via `/api/device/runs/:id/claim` and runs the same loop locally.
   - Every device action except claim, decide and approval-info needs the run **lease**.
4. `packages/core/src/loop.ts` persists every model turn and tool call before acting on it.
   - A crash leaves state that any worker can resume.
   - A call found `running` after a crash is reported as interrupted unless `replaySafe` (read-only calls, and shell commands where `isReadOnlyCommand` is true).
5. `finishRun(runId, outcome, leaseId)` locks the session and then the run. It returns `ended | resumed | paused | lease_lost | missing`.
   - A `completed` outcome carries `seenSeq`; a user message newer than that re-queues the run (`resumed`).
   - When Stop was requested, a late non-final report turns into `cancelled`.
   - When a cloud run ends, `cleanup_pending` is set and `cleanUpCloudRun` runs.

### Lease and lock rules (don't break these)
- Lock order is **session, then run** (`FOR NO KEY UPDATE`) inside `taskTx`, which retries on deadlock (40P01) and serialization (40001).
- Lease checks use `FOR SHARE`. Writes, artifacts (`saveArtifact({leaseId})`) and the final outcome are all fenced by the lease.
- The cloud tick stops the VMs only when `finishRun` returned `ended` and no cloud run of that agent (this one included) is still `queued` or `running`, and only through `stopComputersIfIdle` (W-81): under a `FOR NO KEY UPDATE` lock on the agent's row it checks for active runs and writes a token to `agent_computers.stopping`; after `host.stop()` it clears the token and kicks runs that waited. A tick first takes `FOR SHARE` on the agent's row (waiting out a deciding stopper), then reads the mark **in a new statement**; if set (and < 180 s old) it drops its lease and returns `waiting-for-computer`. Reading only `agent_computers` would miss a stopper's first-ever (inserted) mark.

### Cloud computer (`apps/web/src/lib/runner/sandbox-host.ts`)
- Each agent has two persistent Vercel Sandbox VMs (region `syd1`): `wren-agent-<agentId>` (shell, files, workspace) and `wren-browser-<agentId>` (Chromium + browser daemon on 127.0.0.1:9333).
- Agent commands can't reach the browser VM or its profile. `$HOME` is `/vercel`.
- Shell jobs run through `~/.wren/run.sh` under `setsid`, each in its own session. `$id.run` records the owning run.
- `STOP_JOB` signals the job's session. `STOP_RUN_JOBS` stops every job of a run and exits non-zero if `pgrep -s` still finds any process.
- `endRun()` reports success only when the jobs are gone **and** the browser answered `"ok":true` to `close`. Curl exit 7 (nothing listening) counts as success. Otherwise the cron retries.
- The browser daemon serves only Wren (W-169): at each start it writes a fresh token to `~/.wren/browser.token` (0600, as a header line; made new with `O_EXCL` after removing whatever was at the temporary name, then renamed into place) and `/act` needs it (`ACT` sends it with `curl -H @file`, never on a command line; a pre-token daemon is replaced at the next browser use). It also refuses anything a browser sends (an `Origin` or `Sec-Fetch-*` header, a `Host` other than `127.0.0.1:9333`), needs `content-type: application/json`, takes at most 1 MB and 8 waiting requests, gives receiving 15 s, and checks the action (known name, field types, a `tab`: `close` without one would close the whole browser). The template is in `scripts/gen-daemon.mjs`.
- Long-lived daemons start with `runCommand({detached: true})` + `exec setsid … </dev/null`; otherwise the call hangs. In pkill patterns use `[b]rowser` so the pattern doesn't match its own `bash -lc` command line.
- GitHub is reachable only through the brokered `github.request` tool. No GitHub token is placed in the VM.

### Desktop app
- An Electron window shows the hosted web app (`WREN_URL`, default production). The main process runs `DeviceRunner`.
- **Pairing** is a device-code flow (`/api/device/pair/*`; the user approves on `/app/link` or with one click in the app). The device token is stored with `safeStorage` and hashed on the server. Whoever approves a code gets the computer, and any script in the page can start one (`window.wren.link`), so the app shows a native "Link this computer to <email>?" before saving the credentials, and refuses `link` while linked (unlink first, which also asks natively) or while that question is open (W-142). `main/pairing.ts` (`createPairing`, unit-tested) polls one request at a time (the server hands the token out once, so a 410 can't overtake the approval, W-145); a newer start supersedes an older attempt by generation; a delivery the user declines, one superseded or arriving after a link, or one that couldn't be saved is given back (`POST /api/device/unlink` with that token). Unlink also gives the token back (and cancels any link attempt), so it stops working on the server too. `main/revoke.ts` (`giveBack`) records a token, encrypted (`revoke-pending.bin`), before asking the server, and keeps it until the server confirms; only Wren's own answers count (`{ok:true}`, or 401 with code `device_revoked`; no redirects followed, W-150). Pending ones are retried at start and every 10 minutes. A main record that can't be read when a token is added (keychain unavailable, a read error, a reset keychain) is set aside as `revoke-pending.held-*.bin` and retried with the main one on every round, so it's never dropped (W-155); a damaged entry is skipped, not the whole record. A failed Unlink says whether Wren will keep trying or the computer should be removed on the web (W-148). The server is the backstop: the cron unlinks any computer that was handed a sign-in but never checked in with it within 30 minutes (`revokeUnclaimedDevices`: `last_seen_at = created_at`, which the first heartbeat ends), covering a lost answer and a give-back that couldn't be recorded or sent; the revoke re-checks that in its own UPDATE, so a computer that checked in after being picked stays linked (W-154). The pairing token is derived from the pairing and the desktop's poll secret (`keyedToken`), so a desktop whose answer was lost (timeout) polls again and gets the same one for 10 minutes; the desktop keeps asking up to 10 minutes past the code's 15 after a poll that got no answer. Delivery runs under the pairing's row lock, so two polls make one device (W-151). Anyone holding the pairing's poll secret can fetch the token while it's being delivered: it stays in the desktop's memory only. A web "no" to a code only expires it while it is still unapproved. A link counts as made once it's stored; a failure starting work after that doesn't give it back (W-153). When a heartbeat (or a run's keepalive) gets Wren's own 401 `device_revoked` for the sign-in it used (device API requests never follow redirects), the computer was removed on the web: its tasks are told to stop, the dead sign-in is dropped, and the user is told (W-149). `WREN_AUTOPAIR=1` skips the prompt only in an unpackaged (development) Wren.
- **Unlinking on the server** (`lib/devices.ts`, W-147): `revokeDevice` (Settings' remove and the desktop's give-back) revokes the device and deletes its token in one transaction, then `endOrphanedRuns` ends its unfinished tasks as cancelled (`finishRun(…, { orphaned: true })`: whoever holds the lease, only for a desktop run whose device is revoked; adds "The computer this task was using was unlinked" to the task). The cron runs `endOrphanedRuns()` every minute for anything that slipped past. A task is never created for an unlinked computer (`startTask` re-checks the device `FOR SHARE` in its transaction), and an unlinked device can't claim a run: the claim locks the session first and share-locks the device in one transaction, so an unlink either waits or wins, and can't be followed by the claim marking the task running (W-152). A follow-up to a task whose computer was unlinked ends that run first (decided under the session's lock, `continueOrRestart`) and then tries to start a new one, which fails with "the computer this agent uses isn't linked any more" if the agent is set to that computer; the composer keeps the message. One run that can't be finished doesn't stop `endOrphanedRuns` (the cron retries it).
- **Deleting what lives outside the database** (`lib/cleanup.ts`, W-157): removing an agent or an account deletes its cloud computers with their snapshots (`deleteOrphanSnapshots: true`; the provider deletes those asynchronously and Wren doesn't poll it) and its stored files. "Not found" counts as done in each provider's own terms (Sandbox: a 404 response; Blob: `BlobNotFoundError`, W-161). Any other failure goes into `external_cleanups` (migration 0012, no foreign keys, so it outlives the account), and the cron retries it with backoff: each call gets 15 s (`withDeadline`, which aborts with an `AbortError`, since Blob's SDK retries a `TimeoutError`, W-164), and a batch starts a deletion only if it can end within its budget (35 s, or what is left of the cron's deadline); a row is acknowledged only if unchanged since it was read (`xmin`), so a renewed one isn't lost (W-162). A file's record is removed only after its deletion went through or was queued, and an upload whose record can't be written is deleted again. A removed agent's computers are never made again: `SandboxHost.vm` checks the agent before and after `getOrCreate` and deletes what it just made if the agent was removed meanwhile. Removing an agent marks all its tasks to stop in one statement first, then deletes its computers, then ends idle tasks like Stop does; the cron's `endRemovedAgentRuns` ends whatever a removal that failed or was cut short left (a held task once its worker's lease lapses, W-163). A follow-up, a new task, a resume or a desktop claim for a removed agent is refused (W-158). Task creation share-locks the agent and updates its activity time after commit (W-160).
- **Sign in with ChatGPT** (`main/chatgpt.ts`): each sign-in takes a new generation when it starts, so an older one still exchanging its code can't save over it (W-184). Sign-out empties or deletes the stored sign-in (`clearSecret`: an atomic empty write, else a delete, else, when only the folder can't be changed, emptied in place after an `lstat`/`fstat` identity check with `O_NOFOLLOW|O_NONBLOCK`; each synced to disk; only a missing (ENOENT) or empty file counts as cleared). If it can't, nothing stored is used again in this run, and a marker `chatgpt-signed-out.json` `{at, of}` (written durably; `of` = sha256 of the stored bytes it signs out) keeps that sign-in unused after a restart; it is removed at the first chance. The marker is read strictly: only no file or the `null` a removal writes counts as none, and a marker that can't be read or isn't one keeps the stored sign-in unused (round 26). A marker whose `of` doesn't match what is stored is left over from before a newer sign-in and is dropped, so a stale marker can't undo a later sign-in; a 0.1.31 marker (no `of`) covers whatever is stored, so a sign-in it would undo and that can't be removed is refused with a message. `signOut` returns `{revoked, cleared, recorded}` and one native notification says everything that went wrong, including "in this session only" when neither the clear nor the marker could be saved (W-185). Tests: `test/chatgpt.test.ts` (real folder permissions for the in-place case; a `node:fs` stand-in that refuses one file, like macOS's locked flag, for clear-failed-but-marker-saved and the stale and 0.1.31 markers, each across a module restart).
- **Shell jobs** belong to their task: `shell_status` and a resumed checkpoint only see jobs of the same run (W-186).
- **Window permissions**: the persist:wren session's request **and** check handlers grant only notifications and `clipboard-sanitized-write`, only to Wren's own origin (the page's and the requesting frame's; a check without a page, from Wren's service worker, by its origin); camera, microphone, location, clipboard reading and everything else are denied (checked over CDP in a dev Wren). The agent browser is an installed Google Chrome or Microsoft Edge only: Playwright's own Chromium sits in a cache agents may write, and Wren starts the browser outside any sandbox (W-178). **Engine sign-in** (Settings' Sign in for Claude Code/Grok Build) starts only the program `engineProgram` accepted, by its full path (W-183): on macOS the script Terminal runs (`main/login.ts`, the path single-quoted for bash) is written to a new `mkdtemp` folder in `<dataDir>/login/` (exclusive create, 0700), which agent profiles can neither write nor read, and removed after 10 minutes (or at a start after that: a Terminal opened before a restart may not have read it yet; W-172; it was in the temp folder, which agents may write); on Windows `cmd /k "<path>"`, refused for a path with characters cmd reads itself (`"%^&|<>()!`). A refusal or a failure to open Terminal is a native notification (the page ignores the IPC result, so older web builds need no change).
- **Policy is local and re-read before every action** (`loadPolicy()`): allowed folders, shell, browser and screen switches, and remote approvals. The server can't change it: the window shows the hosted page, and `window.wren.setPolicy` from it can turn permissions **off** freely, but turning shell, browser, screen or remote approvals **on** takes a native "Allow agents on this computer to: …" (`changedPolicy` + `GRANTS` in config.ts, W-142); folders only through the native picker. Reducing permissions kills running jobs and ends engine runs.
- **Engines.** The user's own CLIs are driven unmodified:
  - Claude Code via stream-json, `--permission-prompt-tool` (`mcp-approve.mjs`), `--restricted --tools … --strict-mcp-config --settings <private>/settings.json`. Its built-in file tools (Read, Write, Edit, Grep, Glob) run in its own, unsandboxed process and read the working folders without asking, so the settings file carries deny rules (`claudeDenyRules`: `Read(//path/**)`, `Edit(//path/**)`) for everything in `enginePrivatePaths` (Wren's data folder and app, the credential stores in SECRETS, the other engines' state); `--settings` still applies in restricted mode, and Wren's own approval check (`decide`, `reachesAny`, links followed) refuses those paths too (W-177; checked with Claude Code 2.1.300: reads, Grep and Write are refused there, also through a link, even with the data folder added as a working folder). Checked with the real CLI (2.1.294, 2026-10-09; `test/claude-code.test.ts` replays its output):
    - `--resume` does **not** replay history (unlike Grok's `session/load`); the session id stays the same.
    - The to-do list is TaskCreate/TaskUpdate/TaskList/TaskGet (TodoWrite is gone; both are in `--tools`, unknown names are ignored). They become the plan (items carry the task id, and a follow-up starts from the last plan), not steps.
    - The sub-agent tool is `Agent` (listed as `Task`) and runs in the background: the run gets a `result`, then the sub-agent's events (with `parent_tool_use_id`), then a second turn with its own `system init` and `result`. Each `result` closes that turn's message (filled from `result` if nothing streamed); usage and turns are summed; the session is saved once. Sub-agent tool results close the steps their permission prompts made; their other calls aren't shown.
  - Grok Build via `grok agent stdio` (ACP), with a per-run plugin PreToolUse hook (`grok-hook.mjs`) in `<dataDir>/engines/grok-<runId>` (W-128; check with a write in careful mode that an approval is asked: a hook Grok can't load fails silently). A follow-up resumes the CLI session with `session/load`, which replays the whole conversation as `session/update` notifications before it answers (verified with the real CLI); those are ignored until the load's response, or every old reply and tool call is written again (fixed in 0.1.14, `test/grok-build.test.ts` drives the engine against a fake ACP agent). A `tool_call` that arrives already `completed` is closed at once (that is the engine's report, not an approval record: approvals are only the hook's). Every ACP request settles (W-116): Grok exiting, a write error or Stop (after 3 s, once the CLI is stopped) rejects whatever is pending, and the setup steps have time limits (60 s; `session/load` 180 s); a load that fails because Grok stopped or hung ends the run instead of starting a new session. The run reports its outcome only after the CLI is confirmed stopped.
  - **Attached images** (0.1.16): the runner loads the images on the messages in the prompt through `/api/device/runs/:id/artifact` (this run's account only) and `engines/images.ts` keeps PNG/JPEG/GIF/WebP up to 5 MB, 10 per prompt, naming the rest in the prompt. Claude Code gets them as Anthropic image blocks in its stream-json message; Grok as ACP `image` blocks. Grok 1.0.46 reports `promptCapabilities.image: false` but reads them (checked with two colours); if a version answers the prompt with an image/invalid-params error, it is asked again without them and told so. Other attachments reach engines as names only, as with Wren's own agents.
  - Engine tool calls are mirrored into the timeline by `TimelineWriter` and approved by the same policy.
  - Wren starts an engine program only as the engine's own installer put it in place (`checkEngineProgram` in sandbox.ts): its real file (`realpathSync.native`, so the name as stored, case included) must be inside that engine's install folder (`ENGINE_INSTALLS`: Claude Code `~/.local/share/claude/versions` (+ `~/.local/bin` on Windows) or a Homebrew `claude-code` cask; Grok Build `~/.grok/downloads`, `~/.grok/bin`), a native program for the platform (Mach-O/PE/ELF, `nativeProgram`), outside every folder an agent may write (`agentCanWrite`), and not hard-linked (a pnpm store file, W-178). Anything else (an npm or version-manager install, a wrapper script, a native shim) is refused with `engine_untrusted`: the file Wren could check isn't all that runs, and the interpreter, modules or runtime it loads can be where agents write (W-187). `agentCanWrite` follows the profiles' rules for what it covers (a folder covers itself and what's inside, never `<folder>.anything`; only ENGINE_STATE prefixes match by prefix, W-181; it doesn't see a caller's `readOnly` paths or Grok's hook targets, which only makes it refuse more) and counts Claude Code's own file tools as a writer (the allowed folders minus its deny rules, W-182).
  - `engineProgram(engine, folders)` (engines/program.ts) waits for the user's PATH (`toolEnv`), takes the first copy `findClis` finds (the usual install places, then the PATH folders; no shell is run) that the check accepts, and returns its real file. Every use starts that file, never a name looked up again: the capability report's version probe (an untrusted CLI is reported, not run), the `--help` probe, the run itself and Settings' Sign in (W-183). Both real CLIs were run this way (Claude Code 2.1.300 `-p` turn, Grok 1.0.52 ACP `initialize`): nothing differs from starting them through their links. Grok Build's real program is in `~/.grok/downloads` (`~/.grok/bin/grok` links there) and is protected from Grok's commands, as are its completions.
  - After each completed engine turn a `reasoning` event `{engine, consumedSeq}` is appended. The next turn's prompt is `pendingAsks(events)`. A separate `reasoning` event `{engine, resumeId}` stores the CLI session; the resume lookup must require `resumeId`.
- **Updater.** It reads `/api/updates` (GitHub releases, revalidated every 300 s) and checks the manifest's ed25519 signature against the public key built into the app. It downloads to `<dataDir>/updates`.
  - All requests use Electron `net.fetch` (Chromium's stack: system proxy, OS certificate store) with `cache: 'no-store'`, not Node's fetch. A Windows user's updater sat on "Downloading…" forever; Settings showed "Downloading" for any available-but-not-ready state, which hid the real error (fixed in the web app for all versions, and in the desktop updater for 0.1.9+).
  - Bytes go to `<file>.<sha256[0:12]>.part` and resume with `Range` after a drop, a stall (no data for 2 min) or a restart. A finished but uninstalled download is reused. Failures retry after 5, then 15, then 60 minutes.
  - `check()` returns as soon as a download starts. State carries `received`/`total`/`retryAt`, and Settings shows progress, the error and the retry time. Builds ≤0.1.8 send none of these; the web row copes with both.
  - Install order:
    1. `runner.suspend()`
    2. close the browser (`closeBrowser()`: Playwright first, then the browser's own process group/tree, see below)
    3. `stopAllEngines()` + `stopAllJobs()`, all confirmed
    4. `verifiedCopy` into `<dataDir>/install-*`, re-hashing as it copies
  - macOS: a swap script runs after quit. Windows: the per-user NSIS installer runs silently (`/S`).
  - If agents can't be confirmed stopped, nothing is installed and `runner.resume()` is called.
  - The installer launch waits for the child's `spawn` event (W-83); on `error` Wren stays open with the reason and resumes agents. Before quitting it writes `<dataDir>/update-pending.json` (version, then the installer's pid and program/script once it runs); at the next start `cleanup()` reports an update that didn't install (plus `update-failed.txt` from the macOS swap script, which puts the old app back and reopens it on any failure), and that notice is kept on the next ready update.
  - Wren opened again while that installer may still run starts nothing and exits after a notification, leaving the staging and marker alone (W-96). `installerState()`: `running` (pid alive and its command is that installer, via `ps` or CIM), `unknown` (alive, but the check failed or came back empty; treated as running, W-104), else `gone`; only for a marker < 30 min old. The marker names the installer (program or script) and the time before the launch; the pid is added after it starts, atomically, and a failure there doesn't stop the hand-off (W-105). A marker without a pid is recognised by searching all processes for that installer (W-109): on macOS only a command line that is `/bin/bash <script> …` counts, never one that merely mentions the script (W-120). The installer's last step opens the new Wren, so at startup Wren waits up to 8 s for an installer that's just finishing before giving up and quitting.
- **Agent browser shutdown** (W-136, W-138…W-140): at launch the browser reports its own process id (CDP `SystemInfo.getProcessInfo` over `context.browser().newBrowserCDPSession()`, `browserProcess()` in host.ts); it must be Wren's child (`ownProcess`), and it is recorded with its start time (Windows: CIM creation time; macOS: `ps -o lstart`), so a process given its id later is never taken for it (W-144: `windowsTree(…, born)` matches the root exactly, and a holder of the id with another birth bounds the children; on macOS a Wren child or other program now holding the id means the browser is gone). `adoptContext` waits at most 20 s for that, but tracks the process whenever it is learnt, even later and even after the browser closed (W-143). On macOS it leads its own process group and session (Playwright spawns it detached), with every helper in that group (checked with real Chrome). `closeBrowser()` asks Playwright (15 s), then stops that group (macOS) or tree (Windows, parent-id walk with creation times) through `proctree.killTree`, and returns true only once nothing of it is left; never by command line (the old `--user-data-dir` text match could hit other programs and missed helpers). If the leader's id now belongs to another program, the browser counts as gone and nothing is signalled. A browser Playwright saw close is kept (`strayBrowsers`) until its processes are seen gone. Everything is async (no `execFileSync` on the main process), and it never rejects. Chrome's crashpad handler runs outside the group (parent launchd) and isn't counted. `--selftest --browser` (CI, mac and Windows) checks all of this with a headless browser.
- **Quitting** (W-78): `before-quit` is prevented until `runner.suspend()`, the browser, `stopAllEngines()` and `stopAllJobs()` are done (at most 15 s), then `app.quit()` runs again. A quit that began with SIGTERM stalls there (Electron emits `before-quit` again but never closes; a normal Quit is fine), so 5 s later the session's storage is flushed and `app.exit(0)` runs.
- **Engine steps and approvals:** `decide()` changes a step through `writer.setStep(step, …)` so the writer's copy keeps its risk and approval id when the engine's result arrives; a denied step stays "denied" (the engine then reports the refused call as an error).
- `Wren --selftest` prints JSON and exits; CI uses it. `--selftest --update` also downloads the latest published release through the real updater path, and `--selftest --proctree` checks that something a command leaves running is found and stopped (Windows: ends with its Job Object, and is found by parent id without one), and that a running installer is recognised by its process (with its own marker in a temp folder, never the data folder's, W-107; on macOS the stand-in is bash running a script, as the real installer is, and is also found without its pid). CI runs both on mac and Windows.

### Models (`packages/core/src/models`, `apps/web/src/lib/models.ts`)
- The model sources are: `openai`, `anthropic`, `xai`, `gateway` (Vercel AI Gateway), `platform` ("Wren credits": the operator's Gateway credits, only for `PLATFORM_MODEL_USERS`), `chatgpt` (desktop only), `local`, `claude-code`, `grok-build`.
- **Wren credits are switched OFF for every account (2026-10-07).** One switch, `PLATFORM_CREDITS_ENABLED = false` in `apps/web/src/lib/platform-credits.ts`. Every path that could spend them goes through that file: cloud runs (`resolveCloudModel`), the desktop model proxy, `/api/models?source=platform`, starting a task (`startTask`, so schedules too) and choosing them for an agent (`/api/agents`). Each calls `assertPlatformAllowed()` (403 `platform_disabled`), and the operator token only comes from `operatorGatewayToken()`, which refuses too. `/api/me` reports `flags.platform: false`, so the UI hides the card. An agent still set to Wren credits can be edited; its Settings say they're off and new tasks are refused. A follow-up to a run already queued on them (from before the switch) is accepted by `continueActiveRun`, but that run fails at its first model call (`resolveCloudModel` / the device model proxy), as does a resumed paused one. The switch covers model spending only: Vercel Sandbox (the cloud computers) and Blob still get the deployment's OIDC token inside their own SDKs, as they must. `test/platform-credits.test.ts` fails if anything else imports `@vercel/oidc`. To re-enable: set the constant to `true` and deploy (`PLATFORM_MODEL_USERS` still limits accounts). It is deliberately not an env var.
- Desktop API-key runs go through `/api/device/runs/:id/model`, so keys stay on the server.
- `ResponsesClient` sends every tool namespace as `wren_<ns>`, because OpenAI rejects namespaces that collide with its own reserved ones, such as `computer`.
- `WREN_TEST_MODEL=1` enables the `#script` model (`models/scripted.ts`). A user message `#script [{"call":"computer.shell","args":{…}}, {"calls":[…]}, {"fail":"…"}, {"say":"done"}]` runs one step per model turn.

### Tools (namespace.name)
| Namespace | Tools |
|---|---|
| `computer` | shell, shell_status, read_file, write_file, edit_file, list_files, share_file |
| `browser` | navigate, snapshot, click, type, press, scroll, screenshot, back |
| `web` | fetch (server-side, `guardedFetch`) |
| `github` | request |
| `memory` | remember, forget |
| `task` | ask_user, update_plan, notify |
| `screen` | capture (desktop only) |
| `mcp_*` | user-configured MCP servers |

---

## Security model and decisions

### Subscription rules (researched 2026-10-04; keep them)
The spec says: use official subscription paths only, and never scrape sessions, steal cookies, impersonate official clients, or build fragile auth hacks.
- **ChatGPT plan.** Sign in with ChatGPT through the `dynamic_agent_client` loopback + PKCE flow, which OpenAI allows only for local open-source apps. It is therefore **desktop only** (`apps/desktop/src/main/chatgpt.ts`), with generation-fenced sign-in and sign-out. Settings keep both the ChatGPT-plan and API-key options (`openaiAccess`, `openaiAllowFallback`).
- **Claude plan.** Only the unmodified `claude` CLI is driven. Anthropic forbids Claude login in third-party apps, and Wren never touches Claude's credentials.
- **Grok plan.** Only the official `grok agent stdio` is driven; xAI has no third-party OAuth.
- **Cloud runs** always use API keys. No provider allows a hosted app to use a consumer plan.

### Approvals and risk (`packages/core/src/policy.ts`)
- Risk levels are low < medium < high < critical. Autonomy sets the approval threshold:

  | Autonomy | Approval needed from |
  |---|---|
  | careful | medium |
  | balanced | high |
  | autonomous | critical |

- Some actions are always blocked: typing credentials or card data (by `type`, or key by key with `press`), and catastrophic commands (`rm -rf /`, `dd` to a disk, …). Deletes are read word by word from the text, raw and normalized, twice (`wipesEverything`): as a POSIX shell would (quotes, `\` and `$'…'` removed, W-168) and as PowerShell would (`\` a folder separator, `` ` `` the escape, `{ }` blocks, en/em dashes as `-`, W-175). The command is `rm`, one of Remove-Item's names (`remove-item`, `ri`, `del`, `erase`, `rd`, `rmdir`, any case) or `[System.IO.Directory]::Delete` (recursive with `$true`); PowerShell's `,` separates list items, so every path of `'C:\Users\me','C:\Temp'` counts (W-180); cmd's `rd /s` is recursive; recursive in any spelling (`-r -f`, `-R`, `--rec…`, `-Recurse` and its abbreviations, options after the operands as GNU and PowerShell allow); a target of the root or a drive (`/`, `C:\`), a top-level folder, a home folder (`~`, `~user`, `$HOME`, `$env:USERPROFILE`, `%USERPROFILE%`, `/Users/x`, `/home/x`, `C:\Users\x`) or a folder another `$env:` or `%…%` variable names, with `.`, `..`, `*` resolved, case ignored, `-Path:X` read too.
- **Shell.** `parseShell` is a real lexer covering quotes, `$(…)`, backticks and process substitution. Substitutions inside double quotes are parsed recursively, and `$'…'` is decoded. Backquoted text is unescaped the way the shell does before it is parsed (`\$`, `` \` ``, `\\`, and `\"` inside double quotes; `unBackquote`), so a command nested in escaped backquotes is seen (W-174; bash, zsh and `/bin/sh` all run it). Rules run against both the raw text and the normalized (unquoted) text.
- **Read-only commands.** A command counts as read-only only when all of these hold:
  - it is a bare name or lives in `/bin`, `/usr/bin` or `/sbin`
  - a bare name resolves (per the host's `trustedProgram`, `desktop/src/main/trust.ts`) to a program found on PATH **before** any folder agents can write (`agentWritable()` in sandbox.ts: allowed folders, temp, package caches), following links (W-74). Applied to ratings, engine approvals and crash replay; the cloud passes none. `~/Library/pnpm` itself is no longer writable to agents (only `Library/pnpm/store`), because PNPM_HOME is usually first on PATH.
  - any leading `VAR=` assignments are safe (`LC_*`, `LANG`, `TZ`, `TERM`, colour variables; not `PAGER`/`GIT_PAGER`: `PAGER=./x man ls` runs `./x` even without a terminal)
  - long options count in any abbreviation (`longOpt`: getopt_long accepts unambiguous prefixes; `sort --o=x` writes x, verified, W-113)
  - options that run a program don't count (W-99; verified on macOS): `man` only with page names, sections and `-a/-f/-k/-w/-W` (`-P` runs a pager even without a terminal; `-C`/`-M`/`-H` name more), `sort` without `--co…` (`--compress-program`, any abbreviation), `less`/`more` without `+cmd`/log/lesskey options, `file` without `-z`, `rg` without `--pre`/`-z`, `ag` without `--pager`.
  - `--version` counts only for `git`, `gh`, `docker`: toolchains often run through version managers that pick the binary from project files (rust-toolchain.toml `path`, .tool-versions `path:`, .yarnrc.yml `yarnPath`); `cargo --version` ran an agent-written cargo through rustup (verified).
  - git: only subcommands that read refs and config (`gitReadOnly`: branch/tag listing, `remote -v`, `rev-parse`, `describe` without `--dirty`, `config --get/--list`), matched as whole words. `status`, `diff`, `log`, `show`, `ls-files`, `blame`, `reflog`… are NOT read-only: the repository's own config (agent-writable) can make them run programs (fsmonitor and post-index-change hooks, clean filters, external diff, textconv, `gpg.program` via `log.showSignature`; all verified, W-88). They rate medium with a reason saying so, and aren't replayed after a crash.
  - option-sensitive commands have no dynamic arguments
  - operands are counted with `-` (standard input) and everything after `--` (`uniq - OUT` writes OUT, W-167); an option's value counts as one too (the safe side)
  - the line has no here-document (`<<`, `<<-`) and no comment (a word starting with `#`): the lexer doesn't follow them (`parseShell(…).unsupported`), and a quote in either can hide the next command from it (W-166; bash and `/bin/sh` ignore a quote after `#`, interactive zsh doesn't). Here-strings (`<<<`) are fine.
- A program whose name is only known at run time (`$CMD`, `"$(…)"`, globs) rates **high**.
- **Platform and MCP ratings.**
  - Agent `PATH` keeps absolute entries only (`absolutePath`).
  - Cloud lowers medium to low (and "deletes files" from high to medium).
  - On Windows (no OS sandbox) every shell command rates at least high.
  - Engine shell commands are assessed as unsandboxed.
  - MCP calls rate high regardless of the server's own read-only hints. A server with a token must use https (`connect` in `lib/mcp.ts`, so adding it and every call check, W-170).
- **Browser.**
  - Actions are assessed against the real target element (the focused one for `press`).
  - A press is low only when every key of the chord is known to be plain (`isActivatingKey`, W-165): Playwright presses each part in order (`Enter+a` presses Enter) and takes `\n`/`\r` as Enter, so Enter, Space, their other spellings, anything not in its layout list, and chords with Control/Alt/Meta (page shortcuts, access keys) are assessed like a click on the focused element. Keys that type text are blocked into a password or card field (`typesText`; also refused by the controller and, by the engine's own credential rule, in `arm`). While such a press is on, the guard re-checks the field at every keydown and keypress and at `beforeinput`, both as it starts (window capture) and after the page's own handlers (window bubble): if the page made it a credential field or changed it at all (`fieldState`), say in a handler of the chord's first key, the event is stopped, nothing is typed and the press reports the field changed (W-173). If text still went in (a page handler stopped `beforeinput` before it bubbled back, or changed the field in `input`), the `input` listener and a last check at `disarm` put the field's earlier contents back, and the press says the field changed (or, if that didn't work, `kept`) (W-179).
  - Everything that decides which node an action reaches runs in a Playwright selector engine registered with `contentScript: true` (`ENGINE` in controller.ts), i.e. Playwright's isolated world (W-75). Page scripts can't see its ids or replace the methods it uses. `page.evaluate` is NOT safe for this: Playwright's main-world helper uses the page's `Array.prototype.slice` and even `window.eval`, so a page can hijack any main-world evaluation (verified). The engine also builds the snapshot and element descriptions. Answers come back as a detached `<wren-data data-wren=JSON>` element read with `getAttribute`.
  - `registerSelectors(selectors)` must be called before the browser is launched (desktop host `controller()`, cloud daemon template).
  - Ids (`el-<uuid>`, same id for the same node via a WeakMap, max 500 per document) live only in the engine. Clicks go to `page.locator('wren=id <id>')`, so Playwright hit-tests in that world. Approved actions must still match label, role, inputType, url, href and `form`.
  - Typing (W-77, W-92, W-103, W-106, W-110) happens inside the engine: refuse a secret field by the host's own credential rule applied to everything the field is called now (`secret`: type, autocomplete, aria-label, aria-labelledby text, `<label>` text, placeholder, title; whitespace collapsed, SVG text included), or whose autocomplete/name/id marks a credential (`SECRET_NAME`, the same rule that keeps such values out of descriptions), focus the node, refuse if focus moved (a field that hands focus to a password box) or if the field changed (`fieldState`; a focus handler can make it a password box or retitle it "Password"), select all, check once more, `execCommand('insertText')` into that node. Chrome fires no `beforeinput` for `execCommand` (verified), so no page code runs between that last check and the insertion; a field an `input` handler changes right after gets its old value back (inputs and contenteditable), and the answer says whether that worked (`changed` vs `kept`). Only real input/textarea/contenteditable (labels are refused).
  - Key presses (W-77, W-91, W-102): `arm <id> <key>` splits the chord like Playwright (`Shift+Enter` = Shift, Enter). Only trusted events count (a page can dispatch keyboard events but can't make them trusted), and each keydown must be the press's next key (`isKey`: key, code, `KeyA`/`Digit1`, `Space`, `ControlOrMeta`, and Playwright's Enter aliases `\n`/`\r`, W-112). Until the last one (the key itself) reaches the node, focus is put back after any move and every key event aimed elsewhere is stopped and reported; after it, the press's keypress/keyups aimed elsewhere are swallowed (the key's own effect may move focus). `disarm` reports blocked, and pressOn also refuses to claim success when the guard never saw the key arrive.
  - Each task owns a set of pages: its tab plus every popup opened from them (W-80). `close` closes all of them, keeps the record and returns `ok:false` if any stays open (cloud cleanup then stays pending; desktop closes the whole agent browser).
  - A targeted action that needs approval but has no element ID is refused.
- **Remote approvals off.** Pending approvals for that computer become `localOnly`, and only the desktop's native prompt (`window.wren.decideApproval`) can decide them.

### Two-step sign-in (MFA)
Opt-in per account. Rule in one place: `apps/web/src/lib/mfa-rules.ts` (`mfaStatus`) for the API, `public.wren_session_ok()` (migrations 0009, 0010) for the database. Same logic:
- **Every account, first:** the JWT's session must still exist in `auth.sessions` (W-89). A token outlives sign-out and revocation until it expires; `requireUser()` answers 401 `session_ended`, RLS shows nothing, the app layout sends the browser to `/auth/signout` (drops the cookies of an ended session only, then `/login`), and `api()` does the same on `session_ended`.
- **Email codes on** (`public.mfa_email`): this session must have passed an email code (`public.mfa_session_checks`). Stays required even if a TOTP factor appears: a password-only attacker can enroll TOTP straight through the Auth API (tested), so the email rule is only lifted by turning email codes off from a verified session.
- **Else any verified Supabase factor** (TOTP, recovery codes): the JWT must be `aal2`.
- **Else** nothing more.

How each part works:
- **TOTP and recovery codes** are Supabase Auth factors, used from the browser (`supabase.auth.mfa.*`; recovery codes need `auth.experimental.recoveryCodes`, set in `lib/client/supabase.ts`). Supabase itself refuses at `aal1`: unenroll, a second factor, new recovery codes, password or email change (`insufficient_aal`, tested).
- **Email codes** are Supabase email OTPs: `lib/mfa.ts` calls `signInWithOtp` (code in the Magic Link template) and checks it with a throwaway `verifyOtp`. Wren adds:
  - Codes go to the account's current address from `auth.users` (`wren_mfa_state().user_email`), never the JWT's, which can predate an email change (W-86). `requireUser()` also replaces `u.email` with it.
  - Each send is a request row (`mfa_email_requests`: session, purpose, address). Send returns its `challengeId`; verify needs `{code, challengeId, purpose}` and only finishes that exact request: this session's, that purpose, not used, under 10 minutes, still the account's address, and not superseded (W-90). Supabase keeps only the newest code per account, so a successful send supersedes older requests; a failed send supersedes only itself. Asking again within the minute from the same session and purpose returns the same request (`sent: false`, e.g. after a reload).
  - A send reserves its request under the account's advisory lock (`delivered_at` null: not usable, not handed out), calls Supabase holding no database connection (W-111; Supabase calls time out after 15 s), then marks it delivered and supersedes older requests. Only delivered requests verify (W-100). The same session asking again meanwhile gets `code_sending` (the client waits and asks again); others get the cooldown at once. Request order must be code order (W-101): reservations are ≥ 60 s apart; a send's request to Supabase must go out within 20 s of the send's start (checked in the auth client's fetch, right as it goes out, so a function held up after reserving never sends late, W-114) and gives up 15 s later. A send that still took over 50 s from start to answer (only a paused function) can't know whether its code replaced a newer request's, so it ends its own request and every newer open one (the user asks again). Recording a passed code re-checks everything under the request's row lock (still open and delivered, session alive, same address, no authenticator for "enable") after ending the extra session.
  - `verifyOtp`'s user must be the caller (W-86). The extra session it creates is deleted in the same transaction that records the check (`wren_end_otp_session`: only that user's minutes-old, otp-only session; W-97); if it can't be, nothing is recorded.
  - 5 wrong tries per request, 1 send per minute and 5 per hour per user. Supabase Auth has its own per-user gap (1 s locally).
- **Enforcement:** `requireUser()` refuses unfinished sessions (403 `mfa_required`) unless the route passes `{ mfa: 'skip' }` (only `/api/me` and `/api/mfa/email/*`). Restrictive RLS policies "mfa" on all 14 browser-readable tables (Realtime too). The app layout redirects to `/auth/mfa?next=…` (path from the proxy's `x-wren-path`).
- **Step-up:** `requireUser(req, { stepUp: true })` needs a second step within `STEP_UP_SECONDS` (10 min). TOTP accounts: an `amr` entry `totp` or `mfa/recovery_code`. Others: an email code in this session. Used by account deletion, approving a device pairing, turning email codes off, and changing the password of an account with two-step sign-in.
- **Password changes** (W-87) go through `POST /api/account/password` (MFA finished; step-up if the account has two-step sign-in), which calls Supabase Auth with the caller's own token. Email codes aren't an Auth factor, so Supabase would change the password of any signed-in session: for accounts with email codes on, a deferred constraint trigger on `auth.users` (`wren_check_password_change`) only lets the change commit if a permit (`mfa_password_permits`, issued by that route) exists for a session that survived the transaction. Supabase signs out every other session in the same transaction (verified), so an attacker's session (or the Admin API) can't use someone else's permit. Side effect: an operator can't change such an account's password from the dashboard without turning email codes off first. `/auth/update-password` shows its form only once the session has finished two-step sign-in. Email changes need both inboxes in production ("Secure email change" is on, checked 2026-10-06). In the browser, `api()` answers `step_up_required` with the "Confirm it's you" dialog (`components/app/step-up.tsx`) and retries once. Settings also asks before Supabase-direct changes (UI-level only: Supabase's own gate there is `aal2`).
- **UI:** `/auth/mfa` (TOTP, recovery code, email code; a picker when there are several authenticators, W-93), Settings → Security (`components/app/security-settings.tsx`). Email codes stay listed while they're on, even next to an app (W-95: if turning them off fails during app setup, the user is told and can retry).
- **Recovery codes never outlive the last authenticator** (W-94): an `after delete` trigger on `auth.mfa_factors` (`wren_drop_lone_recovery_codes`, serialized on the user row) removes them in the same transaction, so two removals at once can't leave them as a lone factor (Supabase would still ask for `aal2`). Settings re-reads the factors before removing and can remove a lone set of codes left from before.
- **Redirects** (W-98): every `next` goes through `lib/next-path.ts` (`safeNext`: `/app…` or `/auth/update-password`, same origin, query kept) in the proxy, the auth callback, the sign-in form, the two-step page and the app layout.
- **Lost phone and codes:** `scripts/mfa-reset-user.mjs` (operator only; Supabase Admin API with the secret key, which never goes in the web app).
- **Local stack:** `node scripts/local-auth-recovery-codes.mjs` after `supabase start` (the CLI has no config key for recovery codes yet). `config.toml` turns on TOTP, the code-only Magic Link template (`supabase/templates/verification-code.html`) and the security notification emails.

### Desktop confinement
- **macOS shell.** Commands run under `sandbox-exec` with `seatbeltProfile`:
  - writes only in allowed folders, temp and package caches
  - file contents under `/Users`, `/Volumes` and home unreadable, except allowed folders, toolchains and a few dotfiles
  - credential stores (`.ssh`, `.aws`, Keychains, …) and Wren's data folder never readable
  - files that make programs run later outside the sandbox never writable, even inside an allowed folder such as the home folder (`AUTORUN` / `autorunPaths()` in sandbox.ts, 0.1.30): the folders on the user's PATH (read from the login shell; ~/.local/bin and the like; not a temp folder or an allowed folder itself, 0.1.31), the engine programs (`.local/share/claude`, `.claude/local`, `.grok/bin`, `.grok/downloads`, W-182) and `.local/bin` (where Claude Code's installer puts its command; already on the default PATH, now protected by name too), shell startup files and what they load (`.zshrc`, `.zshenv`, `.zprofile`, `.bashrc`, `.bash_profile`, `.profile`, tcsh's `.tcshrc`/`.cshrc`/`.login`/`.logout`, …, `.oh-my-zsh`, `.zsh`, `.config/fish`, …), tmux and editor configs that run commands (`.tmux.conf`, `.vimrc`, `.config/nvim`, `.emacs.d`, …), git's global config (`.gitconfig`, `.config/git`: aliases, hooks path, filters), `Library/LaunchAgents`, and Claude Code's settings, hooks, instructions and MCP servers (`.claude/settings.json`, `hooks`, `CLAUDE.md`, `commands`, `agents`, `plugins`, `skills`, `.claude.json`); on Windows also the Startup folder and PowerShell profiles. Every profile denies writing them (commands, Grok, Wren's file helper; checked in the real sandbox: appends, other-case names, rename-over, links and new files are refused, reading still works), Wren's file tools and engine approvals refuse them, and Claude Code gets `Edit` deny rules for them (checked with the real CLI). An agent that needs a git identity sets it per repository.
- **Shell environment** (W-108). Commands are not login shells and never get Wren's own environment (it may come from a terminal with tokens, `BASH_ENV`, pager or loader settings): `agentEnv()` (shellenv.ts) passes an allowlist (HOME, USER, LOGNAME, SHELL, TERM, TMPDIR, TZ; on Windows also what Windows needs, e.g. SystemRoot, ComSpec, APPDATA, PSModulePath) plus PATH and toolchain variables (`toolEnv()`, from the login shell on macOS). Engine CLIs get that plus their own sign-in/provider and network variables (`engineEnv(engine)`); Claude Code's commands go through `wren-shell.sh`, which runs them with `env -i` and only the allowlist. Claude Code also starts its **MCP servers** through that prefix (verified), with the server's `--mcp-config` variables. Only Wren's approval server has `WREN_APPROVAL_SB` (set in its private config file): the prefix then runs it under that profile and keeps `WREN_APPROVAL_FILE` and `ELECTRON_RUN_AS_NODE`; the token itself is only in that private file (W-121, 0.1.17). 0.1.13–0.1.15 stripped the server's variables, so on macOS every Claude Code action needing permission was refused with "Wren is not reachable" (fixed in 0.1.16).
- **File tools** (`confined.ts`).
  - On macOS a tiny helper (`cat`, `sh`, `find`, `stat`) runs under `fileOpsProfile`. That profile can read only the allowed folders plus the helpers' own binaries, `/usr/lib` and the dyld cache.
  - On Windows (fallback):
    - walk folder by folder and reject links and junctions
    - create folders one level at a time after checking the parent
    - create new files with `O_EXCL`, verify them, and remove them if they're outside
    - re-check the folder identity around listings
- **Engines.**
  - Grok runs under `engineProfile`, which write-protects hooks, config, trust files, plugins and bin.
  - Claude Code runs unsandboxed in `--restricted` mode. Every command it starts goes through `CLAUDE_CODE_SHELL_PREFIX` (`<dataDir>/bin/wren-shell.sh`), which runs `sandbox-exec` with the profile from env `WREN_SHELL_SB`.
  - Why: nested `sandbox-exec` is impossible, and Claude needs Keychain write access in its own process.
- **Process lifetime.**
  - Engines spawn `detached` (own process group). `killTree` signals the group and polls until it's gone.
  - Windows: `treeAlive`/`killTree` walk processes by parent id from `Get-CimInstance Win32_Process` (only children created while their parent lived, so a reused pid isn't followed) and taskkill until nothing is left. Shell commands also run in a kill-on-close Job Object (`winjob.ts`), so what a command starts ends with it.
  - Job records (`jobs.ts`) stay until the whole tree is confirmed gone: a command that returned but left `server &` running is still tracked, and a stop that wasn't confirmed keeps the record, so a retried update still has to stop it (W-76).
  - Shell jobs die with their run, background jobs and leftovers included.

---

## Audit history (all fixed; details in commit messages)
| Round | Findings | Commit / release | Notes |
|---|---|---|---|
| Codex audit #1 | W-1…W-31 | `35e159d`, desktop 0.1.3 | Seatbelt home-read denial, lease on device API, local-only approvals, cloud VM gets no GitHub token |
| Re-audit #2 | W-32…W-50 | `0097a50` (+`ec93130`), 0.1.6 | Browser in its own VM, jobs die with runs, engine profiles, migration 0006 (`wren_0008_run_invariants`) |
| Re-audit #3 (of 0.1.6) | W-51…W-62 | `1cfcd64`, 0.1.7 | Claude `--restricted` + shell prefix, Grok write-protection, shell lexer, per-task tabs, `seenSeq`, migration 0007 (`wren_0009_run_cleanup`) |
| Re-audit #4 (of 0.1.7) | W-63…W-73 | `06a8109`, 0.1.8 | See below; no migration |
| Re-audit #5 (of 0.1.9) | W-74…W-85 | `e8caf04`, 0.1.10 | See below; migration 0008 (`wren_0010_agent_computers`) |
| Re-audit #6 (of 0.1.10 + MFA) | W-86…W-98 | `d6b695b`, 0.1.11 | See below; migration 0010 (`wren_0012_mfa_hardening`) |
| Re-audit #7 (of 0.1.11) | W-99…W-107 | `42f985f`, 0.1.12 | See below; no migration |
| Re-audit #8 (of 0.1.12) | W-108…W-113 | `853a342`, 0.1.13 | See below; migration 0011 (`wren_0013_mfa_send_state`) |
| Re-audit #9 (of 0.1.14) | W-114…W-120 | `8fcfc9a` (+`ca370e6`), 0.1.15 | See below; no migration |
| Re-audit #10 (of 0.1.16) | W-121…W-127 | `c1e8237`, 0.1.17 | See below; no migration |
| Re-audit #11 (of 0.1.17) | W-128…W-132 | `a37d43b`, 0.1.18 | See below; no migration |
| Re-audit #12 (of 0.1.18) | W-133…W-137 | `2a15d1d`, 0.1.19 | See below; no migration |
| Re-audit #13 (of 0.1.19) | W-138…W-142 | `fa6d25c`, 0.1.20 | See below; no migration |
| Re-audit #14 (of 0.1.20) | W-143…W-146 | `1a49ef5`, 0.1.21 | See below; no migration (new route `POST /api/device/unlink`) |
| Re-audit #15 (of 0.1.21) | W-147…W-148 | `46e3e4f`, 0.1.22 | See below; no migration (cron also ends unlinked computers' tasks) |
| Re-audit #16 (of 0.1.22) | W-149…W-153 | `9000dcb`, 0.1.23 | See below; no migration |
| Re-audit #17 (of 0.1.23) | none new (W-151, W-148 remainders) | `d5b4b32`, 0.1.24 | See below; no migration (cron also unlinks computers that never checked in) |
| Re-audit #18 (of 0.1.24) | W-154…W-159 | `a3e8d7a`, 0.1.25 | See below; migration 0012 (`wren_0014_external_cleanups`); W-156 documented |
| Re-audit #19 (of 0.1.25) | W-160…W-162 | `5c699aa`, 0.1.26 | See below; no migration |
| Re-audit #20 (of 0.1.26) | W-163…W-164 | `1445752`, web only | See below; no migration |
| Re-audit #21 (of 0.1.26 + web) | W-165…W-171 | `c6b41a1`, 0.1.27 | See below; no migration |
| Re-audit #22 (of 0.1.27) | W-172…W-176 | `ca7b1e9`, 0.1.28 | See below; no migration |
| Re-audit #23 (of 0.1.28) | W-177…W-180 | `12d2a8d`, 0.1.29 | See below; no migration |
| (hardening) | files that run later (AUTORUN) | `ed1c8aa`, 0.1.30 | Shell startup files, git global config, LaunchAgents, Claude settings |
| Re-audit #24 (of 0.1.30) | W-181…W-186 | `737bf84`, 0.1.31 | See below; no migration |
| Re-audit #25 (of 0.1.31) | W-187 (+W-183, W-185 remainders) | `c0e887a`, 0.1.32 | See below; no migration |
| Re-audit #26 (of 0.1.32) | none new (W-185 remainder) | (this commit), 0.1.33 | See below; no migration |

Round 26 in brief (desktop 0.1.33; Codex report /private/tmp/wren-re-audit-0.1.32-2026-10-16.md, of `bb2aae0`; W-187 and the W-183 sign-in remainder confirmed closed; Codex ran the suites, incl. real Chrome, and checked the feed's signatures):
- **W-185 remainder** (Medium) the sign-out marker was read with `readJson`, which returns its fallback for any read or parse error, so an unreadable or malformed marker counted as none: after a restart the old stored sign-in was used again (reproduced: `recorded: true`, then the marker made unreadable), and a new sign-in "removed" an unreadable 0.1.31 marker without writing, which then signed it out after the next restart. The marker is now read strictly (`readMarker`: `none` only for no file (ENOENT) or the `null` a removal writes; `unknown` for any read error, bad JSON or a wrong shape); `unknown` keeps the stored sign-in unused (replaced only when nothing is stored), `dropMarker` succeeds only once the marker reads back as none (writing `null` replaces an unreadable one), and a sign-in is refused when what is left is unknown or covers it. Tests (real file permissions; each fails on 0.1.32): a recorded sign-out with an unreadable marker across a restart, five malformed markers, an unreadable 0.1.31 marker replaced by a new sign-in, and one that can be neither read nor replaced.

Round 25 in brief (desktop 0.1.32; Codex report /private/tmp/wren-re-audit-0.1.31-2026-10-16.md, of `a5f75fe`):
- **W-187** (High, conditional on a wrapper-style install) 0.1.31 trusted an engine launcher because its own file was in a protected PATH folder, though the code it loads could sit where agents write (reproduced against 0.1.31's `untrustedProgram`: a script in a protected `~/.local/bin` running a runtime from the allowed home folder was accepted). Wren now starts an engine only as its own installer put it: a native program inside that engine's install folder (`checkEngineProgram`), and every use starts that same real file (`engineProgram`). The installed Claude Code and Grok Build pass (both link only system libraries); wrappers, npm installs and native shims are refused with a reason.
- **W-183 remainder** Settings' Sign in for Claude Code/Grok Build ran a bare `claude`/`grok` that Terminal's shell looked up: it now goes through the same check and runs the checked program by its full path (quoted; on Windows refused for paths cmd would read itself), and says why when it won't.
- **CI flake** (not a finding): the first v0.1.32 tag run failed in `updater.test.ts` (W-109's pid-less installer search saw the stand-in installer after it was killed). Its script ran `sleep`, and bash's forked child shows bash's own command line until it execs, so a kill in that instant left a look-alike; the stand-in now waits in a `read` on a pipe (no child). The failed jobs were re-run on the same tag (no tag move); the fix is in the next commit.
- **W-185 remainder** (Medium) the restart marker was written to the same folder whose failure stopped the clear, its failure was ignored, the notification hid a failed revocation behind a failed clear, and a stale marker could delete a newer sign-in: the stored sign-in is emptied in place when only its folder is locked, the marker names the sign-in it covers and is written durably, `recorded` is reported, and the user is told if the sign-out holds for this session only (details in "Sign in with ChatGPT"; the five tests fail on 0.1.31, including the newer sign-in being deleted).
- Also: Wren's file tool waits for the user's PATH before deciding what is protected (it used the start-up guess until the login shell answered); `~/.local/bin` is in AUTORUN by name; the report's wording point that `agentCanWrite` "mirrors the profiles exactly" is corrected (it errs toward refusing where it doesn't see a caller's paths). Tests: the install-folder rule (launcher with a writable runtime, a native shim, an npm install, a script and a hard link in the install folder, the real installs), the first acceptable copy wins over one planted earlier in the lookup order, and the sign-in script running the checked file even with a decoy first on PATH.

Round 24 in brief (desktop 0.1.31; Codex report /private/tmp/wren-re-audit-0.1.29-2026-10-16.md, of `ed1c8aa`; the fresh pass covered Windows code, the task lifecycle and leases, Sign in with ChatGPT and the model adapters, and the desktop's other tools):
- **W-181** (High) the program-trust check counted `<protected folder>.anything` as protected (`~/.claude.payload/cli`), unlike the profiles: it now matches folders exactly and only real file-name prefixes by prefix.
- **W-182** (High) Claude Code's own file tools could rewrite its installed program, which the check trusted: the engine programs are in AUTORUN (no agent writes them, Claude's own tools included), and the check counts Claude's file tools as a writer.
- **W-183** (High) the capability report ran both CLIs (`--version`) without the check, and `findCli` ran a login shell: the version probe is checked first and reports an untrusted CLI without running it; `findCli` reads the PATH Wren already has.
- **W-184** (Medium) a newer ChatGPT sign-in didn't stop an older one that was still exchanging its code: each sign-in takes its generation at the start.
- **W-185** (Medium) a sign-out whose local clear failed left a usable sign-in: the clear is checked, a failed one is never used (this run, and after a restart through a marker), retried, and reported.
- **W-186** (Low) `shell_status` read any task's job by id: only the same run's jobs.
- Also: the folders on the user's PATH are no longer writable to agents when an allowed folder contains them (tested in the real sandbox); tcsh startup files; W-179 remainder (the last check at the end of a press runs after an earlier restore too, and a restore only follows input into the checked field; tested in Chrome: a page that puts the text back gets it removed again, the previous controller left it); W-180 remainder (PowerShell arrays `@('…','…')` and nested lists are read, `${env:…}` is a variable, PowerShell's own options are recognised by name so `-Confirm`/`-Force` no longer count as recursive, `$true` only for Directory.Delete); a login-script open that rejects is reported. Tests: ChatGPT sign-ins out of order and a failed clear (stand-ins, no network or keychain), job ownership, the capability probe never running a planted CLI, the trust check's sibling and Claude-writer cases; each fails on the previous code.

Round 23 in brief (desktop 0.1.29; Codex report /private/tmp/wren-re-audit-0.1.28-2026-10-15.md; the fresh pass covered the macOS profiles, the updater, the engines, the cloud shell layer and agent-written content):
- **W-177** (High) Claude Code's built-in file tools run in its unsandboxed process and only Wren's folder check applied to them, and reads didn't even ask: with a folder allowed that contains them (the home folder), Claude Code could read or rewrite Wren's data (its policy), the sign-in scripts or `~/.ssh`. Claude Code now gets deny rules for Wren's data and app, credential stores and other engines' state, and Wren's approval check refuses those paths (tested with the real CLI: refused directly, through a link and with the folder added; without the rule it read the file).
- **W-178** (High) Wren fell back to Playwright's Chromium in `~/Library/Caches/ms-playwright`, which agent commands may write, and started it outside any sandbox: no such fallback (Chrome or Edge). Engine programs are checked the same way before Wren starts them (`untrustedProgram`; the installed Claude Code and Grok pass, with the home folder allowed too), and Grok's real program (`.grok/downloads`) and completions are protected from Grok's commands.
- **W-179** (Medium) a page's own `beforeinput` handler could change the field after Wren's check: Wren checks again after the page's handlers and takes text back out of a field that changed (tested in Chrome: relabelled in `beforeinput`, with propagation stopped, or in `input`; the old controller typed into the first).
- **W-180** (Medium) a PowerShell list (`'C:\Users\me','C:\Temp'`) hid a home folder from the delete check: list items are read one by one; cmd's `rd /s` and `[IO.Directory]::Delete(…, $true)` count too.
- Also: notes agents saved are given to them as notes, one line each, not instructions, and the system prompt says not to remember instructions from pages or files (persistent prompt injection); a sign-in script that can't open Terminal is reported and one less than 10 minutes old survives a restart; service-worker notification checks pass in the Wren window; the cron expires at most 100 approvals a call, checks its time before the second housekeeping query and before the cleanup stage starts work past its own cap.

Round 22 in brief (desktop 0.1.28; Codex report /private/tmp/wren-re-audit-0.1.27-2026-10-15.md; the fresh pass covered every API route, RLS and definer functions, file delivery, the Electron window and IPC, web.fetch, schedules and account deletion):
- **W-172** (High) the engine sign-in script Terminal runs was written to the temp folder, which agent commands may write, so a running agent could swap what Terminal ran outside the sandbox: it is made in a new folder inside Wren's data folder (tested in the real sandbox: an agent command can't write, move, replace or read it, and can write the old place).
- **W-173** (Medium) a page could turn a field into a password field between the keys of a chord: the guard re-checks the field through the press and at `beforeinput` (tested in Chrome: a field changed on Shift, on the typing key's own keydown, or relabelled "Password" gets nothing; the old controller typed into all three).
- **W-174** (Medium) a command in escaped nested backquotes was invisible to the lexer (rated low): backquoted text is unescaped as the shell does before parsing.
- **W-175** (Medium) the new delete check missed PowerShell's `RM` (it was case-sensitive): deletes are also read as PowerShell, with Remove-Item's names, its parameters and Windows paths.
- **W-176** (Low) opened files stayed in the browser's cache for an hour: `no-store`.
- Also: the cron's deadline covers each whole stage, its queries included (`late` in the report), and reaches `revokeDevice`'s task ending; the Electron window has a permission check handler matching its request handler (frame origin checked too); the daemon's token file is created exclusively; the 50-schedule limit is enforced under a per-account lock; `fetchReadable` releases redirect bodies and reports too many redirects instead of showing a 3xx as the page; the wake channel is described as what it is (public, random-named, content-free).

Round 21 in brief (desktop 0.1.27; Codex report /private/tmp/wren-re-audit-0.1.26-web-2026-10-14.md; a fresh pass over unchanged policy, browser and integration code):
- **W-165** (High) `"\n"`/`"\r"`, which Playwright presses as Enter, rated low on a "Place order" button: a press is low only if every part of the chord is a key known to be plain; Enter's and Space's spellings, unknown keys and Control/Alt/Meta chords are assessed against the focused element (policy and full-loop tests). Also: pressing letters into a password or card field one key at a time is blocked by the policy and refused by the controller (tested in Chrome).
- **W-166** (Medium) a here-document's text could hide a command from the read-only lexer: lines with a here-document or a comment are never read-only. Checked with bash 3.2, `/bin/sh` and zsh: the hidden command runs (the comment form too).
- **W-167** (Medium) `uniq - OUT` and `xxd - OUT` looked read-only: `-` and everything after `--` count as operands. Also `yq -s` and `tree -R` (both write files) aren't read-only.
- **W-168** (Medium) `rm -r -f ~` wasn't blocked: rm's options and targets are read word by word, in any spelling and order.
- **W-169** (Medium, conditional) the cloud browser daemon served any POST to 127.0.0.1:9333: token, browser-request refusal, limits and action checks (see Cloud computer). Tested with the generated daemon and headless Chrome: a page's `fetch`/form POST closed another task's tab with the old daemon and was refused by the new one; every bad request shape gets its 4xx.
- **W-170** (Low) a token-bearing MCP server could be plain http: refused when adding it and on every call.
- **W-171** (Low) the key hint could show all of a short secret: prefix and last 4 only when at least 16 characters and half stay hidden. Production had no connections, so no stored hint needed fixing.
- Also: the cron answers within one 45 s deadline (database-only stages first, `skipped` in the report; tested with a hanging stage); a deletion batch starts nothing that couldn't end within its budget; the MCP help text no longer says read-only tools run without asking.

Round 20 in brief (web only, desktop stays 0.1.26; Codex report /private/tmp/wren-re-audit-0.1.26-2026-10-14.md):
- **W-163** (Medium) removing an agent cancelled its tasks one by one and ignored failures, with no backstop: all its tasks are marked to stop in one statement first, computers are deleted before the per-task work, errors are logged, and the cron ends removed agents' leftover tasks (tested locally: a removal cut short after archiving is finished by the cron, a held task once its lease lapses).
- **W-164** (Low) Blob's SDK retried past the 20 s timeout (it retries a `TimeoutError`): deletions abort with an `AbortError` at 15 s and return control at the deadline, and the cron starts no new deletion after 20 s.
- Also: a removed agent's paused task can't be resumed; a failed clean-up of an unrecorded upload no longer hides the record's error.

Round 19 in brief (desktop 0.1.26; Codex report /private/tmp/wren-re-audit-0.1.25-2026-10-14.md):
- **W-160** (Low) two new tasks for one agent could deadlock upgrading the agent's share lock: the activity update moved after commit (six parallel starts tested locally).
- **W-161** (Low) Blob's typed not-found kept an already-deleted file in the retry queue: each provider's own "not found" counts as done.
- **W-162** (Medium) a retry could acknowledge (delete) a queue row renewed meanwhile: acknowledgement and backoff are conditioned on the row's `xmin`; provisioning re-checks the agent before and after making a computer and deletes it if the agent was removed.
- Also (W-157/W-158 remainders): a file's record goes only after its deletion is done or queued; a failed upload record cleans up its upload; removing an agent ends idle tasks now and its follow-ups, new tasks and desktop claims are refused (tested locally); provider calls in the cron are bounded; unclaimed-device errors are logged; an emptied held give-back record that can't be removed doesn't stop the retry round.

Round 18 in brief (desktop 0.1.25; Codex report /private/tmp/wren-re-audit-0.1.24-2026-10-13.md; migration 0012):
- **W-154** (Medium) the unclaimed-device cleanup revoked from a stale list: the revoke re-checks "never checked in" in its own UPDATE.
- **W-155** (Medium) a give-back record that couldn't be read once was retired for good: it's held and retried with the main record, and a damaged entry no longer takes the others with it.
- **W-156** (Medium) per-task cleanup in a cloud VM trusts records the agent can change (it has sudo there): documented in Known limitations; the VM stop still ends everything.
- **W-157** (Medium) deleting an agent or account kept the computers' snapshots and dropped failed deletions: snapshots are deleted, and failures are kept in `external_cleanups` and retried by the cron.
- **W-158** (Medium) a task prepared before an agent was removed could still start: task creation re-checks the agent under its row lock, and a cloud tick ends a removed agent's run.
- **W-159** (Low) a "no" that lost to an approval still said it was declined: it now answers 409.
- Also: a pairing answer whose body is `null` counts as no answer; the deadline test matches the server's window; follow-ups hold the computer's row while their message goes in (W-147 remainder); an index for the unclaimed-device scan. Tested against the local stack (a late check-in stays linked; a queued deletion of a missing computer clears; a late "no" gets 409).

Round 17 in brief (desktop 0.1.24; Codex report /private/tmp/wren-re-audit-0.1.23-2026-10-13.md; no new findings, two retained):
- **W-151 remainder** the desktop stopped polling at 15 minutes even when the server could still re-deliver a lost answer: it keeps asking up to 10 minutes longer after a poll without an answer. Plus the server backstop below.
- **W-148 remainder** a give-back that couldn't be recorded was dropped for pairing: the cron now unlinks computers that never checked in within 30 minutes; an undecryptable record is moved aside instead of blocking; record errors can't escape.
- Also: device API requests don't follow redirects and removal needs Wren's own 401; the follow-up check moved under the session lock; a stale web "no" can't undo an approval; the pairing id is canonical in the token derivation; a clearer error when an agent's computer was unlinked. Tested against the local stack (follow-up to an unlinked computer's task; an unclaimed device unlinked, a checked-in one left alone).

Round 16 in brief (desktop 0.1.23; Codex report /private/tmp/wren-re-audit-0.1.22-2026-10-11.md):
- **W-149** (Medium) a computer removed on the web only stopped polling; its running tasks went on: a `device_revoked` heartbeat or keepalive now aborts them, drops the dead sign-in (only if it's still the one the request used) and tells the user. Tested in a dev Wren against the local stack.
- **W-150** (Medium) any 2xx or 401 counted as a confirmed give-back: only `{ok:true}` or 401 `device_revoked` does, and redirects aren't followed.
- **W-151** (Low) a pairing answer lost to the new timeout lost the token: it's derived from the poll secret and delivered again for 10 minutes, under the pairing's row lock (tested: two polls at once make one device and get the same token; after a give-back nothing is delivered).
- **W-152** (Low) a claim could mark a cancelled task running: claim is one transaction, session locked first.
- **W-153** (Low) a failure starting work after a link was stored gave the stored token back: only a failed store does now.
- Also: storage failures in the give-back record are reported, and an unreadable record isn't overwritten (W-148 remainder); the revoke transaction retries like other task transactions; `endOrphanedRuns` carries on past a failing run; follow-ups to an unlinked computer's task start a new run.

Round 15 in brief (desktop 0.1.22; Codex report /private/tmp/wren-re-audit-0.1.21-2026-10-11.md):
- **W-147** (Medium) unlinking only flagged the computer's tasks, which nothing could then finish: they end as cancelled now, on the server (`revokeDevice`/`endOrphanedRuns`, also from the cron), the revoke is one transaction, and creating or claiming a task for an unlinked computer is refused. Tested against the local stack (queued and leased tasks, and the cron catching a leftover).
- **W-148** (Medium) a token given back was forgotten even when the server couldn't be reached: kept encrypted until confirmed, retried, and a failed Unlink says so.
- Also: a browser identified after the 20 s wait is still tracked (W-143 remainder); private folders with pattern characters are pruned literally (escaped) in macOS listings; a delivery that can't be saved is given back, and Unlink calls off a link attempt; pairing requests time out after 20 s; tests for launch-at-login and the give-back record.

Round 14 in brief (desktop 0.1.21; Codex report /private/tmp/wren-re-audit-0.1.20-2026-10-10.md):
- **W-143** (Medium) a browser that closed while its process was being identified fell out of both registries: `adoptContext` remembers the close and tracks the process once known; discovery is limited to 20 s.
- **W-144** (Medium, Windows) the browser's record accepted any process with its id created after launch: it is now matched by its exact creation time; the same start-time check on macOS tells it from another Wren child given its id.
- **W-145** (Low) overlapping pairing polls could let a 410 discard the one delivery: polls are sequential, attempts have generations, and declined, superseded or late deliveries give their token back (new `POST /api/device/unlink`, also used by Unlink).
- **W-146** (High, conditional on a hostile analytics script) the reload guard trusted `window.va` and ran after the private page was drawn: `SiteAnalytics` now wraps the pages and draws nothing non-public in a document that loaded analytics, by its own state.
- Also: `Referrer-Policy: strict-origin` (W-141 remainder); macOS listings prune Wren's folders inside `find`, so they don't use up the limit (W-134 note); `WREN_AUTOPAIR` only in unpackaged builds; turning on launch-at-login needs the native prompt too; the account address in the link prompt is shown as plain text; the bridge checks arrival limits every 5 s (W-135 note); unlink waits at most 10 s for the server.

Round 13 in brief (desktop 0.1.20; Codex report /private/tmp/wren-re-audit-0.1.19-2026-10-10.md):
- **W-138** (Medium) the browser-close fallback matched `--user-data-dir=…` anywhere in any command line (Windows: a plain substring, so `agent-browser-backup` too) and killed what matched: replaced by the browser's own reported process, stopped as its group (macOS) or tree (Windows).
- **W-139** (Medium) "no process with that flag" counted as closed, though helpers without the flag could live on: now the whole owned group/tree must be gone.
- **W-140** (Medium) the fallback ran `execFileSync` (CIM 15 s, taskkill 10 s each) on the main process, freezing the 15 s quit deadline: all async now. Also: a rejected browser close could leave quit hanging (the shutdown promise now catches), `closeBrowser` never rejects, `closeRunTab` goes through it.
- **W-141** (Medium) analytics saw private paths (`/app/s/<id>`) and its script fetch carried same-origin referrers: analytics now loads on the public pages only.
- **W-142** (High, conditional on a hostile analytics script) the separately fetched analytics script ran on sign-in, app and desktop pages, where page scripts can read the session and call `window.wren` (silently turning permissions on, starting a pairing another account could approve). Analytics is off those pages, and the desktop now asks natively before any permission is turned on and before linking to an account; `link` is refused while linked.
- Also: W-133 remainder (a dev build also protects the real folder of runtime modules, `playwright-core`/`electron`, when linked); macOS listings leave out Wren's own folders too (W-134 note); a second Wren instance does no startup work; leftover `<dataDir>/engines` and `<dataDir>/approvals` from a crash are removed at start (W-137 note); the bridge's arrival limits are a parameter and tested against a slow request and a slow decision (W-135); tests for the data-folder refusal and the dev-build set (sandbox-integrity), the policy rule (policy-change), cancelled steps after the engine's report.

Round 12 in brief:
- **W-133** (High, dev builds) a dev Wren (`electron .`, not packaged) also protects what it runs from outside its build: `apps/desktop/package.json` (the start file) and every ancestor `node_modules` (playwright-core loads there at the first browser use). Tested: an agent command can't write either, and can still edit `src/`. On macOS the app bundle comes from `process.execPath` only when it is a `.app` (plain Node gave `/usr`).
- **W-134** (High, Windows) Wren's own file tools (read, write, list) refuse Wren's data folder (policy, device sign-in, updates, approval folders) and the app folders on every platform, whatever is allowed (case-insensitive on Windows); listings skip them. Tested on macOS through the software check: writing `policy.json` is refused ("part of Wren itself").
- **W-135** the bridge tracks a request from admission; closing it (a `closing` flag, 503 afterwards) calls off requests still arriving too; `requestTimeout` 15 s / `headersTimeout` 10 s cover receiving a request only (decisions may wait as long as needed).
- **W-136** `closeBrowser()` keeps the browser known until it's confirmed closed, shares one attempt between callers, and if Playwright can't close it within 15 s stops the processes started with `--user-data-dir=<dataDir>/agent-browser` (ps / CIM) and checks they're gone. `adoptBrowser()` registers the controller.
- **W-137** Grok's setup (plugin folder, files, spawn) cleans up the bridge and plugin if anything fails; its final clean-up runs each step on its own. Claude Code's private folder path is computed inside its try (W-131 remainder).
- Also: `decide()` re-checks Stop after marking an approved step running (W-122 remainder); a withdrawn approval's step is "cancelled" (shown as stopped), and `toolEnd` leaves it so; `ancestorsWithin` compares whole path components.

Round 11 in brief:
- **W-128** (High) what enforces approvals can't be changed by agents: every agent profile (commands, engines, Wren's own file helper) ends with `(deny file-write* …)` for this app's folders (`appDirs()`: the bundle from `process.execPath`, the built `dist-electron`) and for the `readOnly` paths, even inside an allowed folder; `writeConfined` refuses them too (Windows). Grok's per-run plugin (its PreToolUse hook) moved from the temp folder to `<dataDir>/engines/grok-<runId>`; Grok's profile alone may read it, plus `file-read-metadata` on its parent folders inside the data folder (Grok resolves the path: without that it silently loaded no hook and wrote without asking; caught in an end-to-end run).
- **W-129** a bridge request holds its place (32 at most, 512 KB by bytes) until its decision ends, not just its connection; when the asker leaves, the handler's signal fires, `decide()` withdraws the approval (`RemoteStore.withdrawApproval`, the device `decide` action, denied) and closing the bridge calls everything off.
- **W-130** after an unconfirmed engine stop, Wren only watches (every 15 s) and never signals again: the group number could be another program's once it's gone. A stop confirmed by anyone (quit, update) ends the watch; a group seen gone is no longer tracked.
- **W-131** Claude Code's bridge, private folder, Stop listener and final engine stop are released in a `finally`, each on its own.
- **W-132** a call the stream reports after its permission prompt made the step still ends the agent's message there.
- Also: a stopped run gets no answer from Grok's pathless-read shortcut, and `decide()` re-checks before every allow; the browser counts toward "confirmed stopped" (quit and update); the approval helper has no environment fallback any more; PNG needs the full 8-byte signature; the self-test's timer and errors are handled. Found while testing: 0.1.17's step-matching rule made a second, never-finishing step for every approved Grok action (Grok's stream called it `grok.tool`): generic engine steps can be taken over again, and Grok's stream names "other" tools the way its hook does.

Round 10 in brief:
- **W-121** Claude Code's approval bridge token is no longer on any command line or in any environment (agent commands can read both for every same-user process on macOS, tested): `--mcp-config` is a file in `<dataDir>/approvals/<runId>/` (0700, removed after the run) next to `approval.json` (url, token). `wren-shell.sh` runs the approval server, and only it (its config sets `WREN_APPROVAL_SB`), under `approvalServerProfile` = the command profile plus a final `(allow file-read* (subpath <that folder>))`, which wins over the data folder's deny; commands can't read the folder (tested: "Operation not permitted") and can't start a second sandbox. The bridge compares the token in constant time, takes at most 8 open requests and 512 KB each; `decide()` won't attach a request to a step for another kind of action. Grok's bridge token stays in Grok's environment (its commands are its children; see Known limitations).
- **W-122** Stop or a lost lease (409) ends image loading (`deviceJson` gets the run's signal); no engine starts for a run already stopped; `decide()` denies everything once the run is stopped.
- **W-123** Grok is re-prompted without images only on a JSON-RPC -32602 answer before the prompt did anything (no reply, plan, tool call or permission request).
- **W-124** quitting checks what was confirmed stopped (runs, engines, commands; the browser no longer holds the others up); if not everything was, `<dataDir>/quit-unconfirmed.json` makes the next start say so. Quitting still never waits more than 15 s.
- **W-125** a send that took too long ends every open request of the account, older ones too.
- **W-126** `finishEngine()` after each engine turn (Claude Code too, for what it left running): an unconfirmed stop is said on the task and retried every 30 s (10 times); the engine stays tracked for quit/update.
- **W-127** the plan changes only on what Claude Code reports done: TaskUpdate only with `success: true`, TaskList replaces the plan with Claude Code's own list, TaskGet refreshes an item.
- Also: the remaining W-119 part (cancelled steps and the "Stopped" divider say "Stopping…" while cleanup is pending); images are checked by their bytes (PNG/JPEG/GIF/WebP signatures, the returned type) and at most 20 are downloaded per prompt; `--selftest` now starts the approval server and gets a decision through it (an empty helper passed the old existence check); a background sub-agent's permission prompt no longer cuts the agent's message in two.

Round 9 in brief:
- **W-114** an email send held up after reserving can't reach Supabase late (20 s start deadline in the fetch); one that took over 50 s ends its own and newer requests.
- **W-115** Stop, Pause and Resume decide under the task's locks (session, then run); Stop finishes a run only if, under the lock, it is still active and nobody holds its lease (`finishRun(…, { idle: true })`), so a worker that claimed or finished it meanwhile is never overwritten, and `done` is true only when it really ended or paused.
- **W-116** Grok Build: every ACP request settles on exit, write error, Stop or a setup time limit; the run waits for the CLI to be confirmed stopped.
- **W-117** `file -C`/`--compile` (writes a compiled magic file) isn't read-only.
- **W-118** credential names are split into words first (`otpCode`, `pinCode`, `OTPInput`), for typing, descriptions and snapshots.
- **W-119** a step of an ended run that never reported shows "Didn't finish", or "Stopping…" while the cloud run's `cleanup_pending` is set (not "Stopped").
- **W-120** a pid-less installer marker matches only `/bin/bash <script>` (how `install()` starts it), not any command mentioning the script; and a Wren opened by the installer's last step waits up to 8 s for it to exit instead of quitting.

Round 8 in brief:
- **W-108** agent commands get an allowlisted environment, never Wren's own (tokens, BASH_ENV, pagers); engines keep only their own sign-in and network variables, and Claude Code's commands are stripped to the allowlist by `wren-shell.sh`.
- **W-109** the update marker names the installer before it starts; a marker without a pid is recognised by searching processes.
- **W-110** a credential's name/id counts, label whitespace is collapsed, SVG label text is read.
- **W-111** email sends hold no database connection while Supabase sends (reserve, send, mark delivered).
- **W-112** Playwright's `\n`/`\r` count as Enter.
- **W-113** long options are matched in any abbreviation (`sort --o=x` wrote x).

Round 7 in brief:
- **W-99** `man -P`, `sort --compress-program` (and abbreviations) and similar options aren't read-only; neither is `--version` of toolchains behind version managers (rustup ran an agent-written cargo).
- **W-100** an email-code request is invisible until Supabase sent its code; recording re-checks the request, session, address and factors under a lock.
- **W-101** sends serialized per account through Supabase's answer, with a time limit.
- **W-102** the key guard counts only trusted keydowns that match the press's keys.
- **W-103** the engine applies the credential rule to every name of the field (title, `<label>`, aria-labelledby) before and while typing.
- **W-104** an installer check that fails for a live pid counts as "may be running" (files kept).
- **W-105** publishing the installer's pid can't break the hand-off; the marker is written atomically.
- **W-106** contenteditable fields get their old contents back too; Wren says if that didn't work.
- **W-107** the installer self-test uses its own marker.

Round 6 in brief (details in "Two-step sign-in" and "Approvals and risk"):
- **W-86** email codes go to the current address; `verifyOtp`'s user must be the caller; a request is tied to its address.
- **W-87** password changes through Wren only (permit + deferred trigger on `auth.users`) for accounts with email codes.
- **W-88** git: only ref/config reads are read-only, matched as whole subcommands; `PAGER`/`GIT_PAGER` no longer safe assignments.
- **W-89** a session must still exist (API, RLS, app layout).
- **W-90** email checks bound to a request id and purpose; newer sends supersede older requests; the enable dialog confirms with the server.
- **W-91** the key guard covers the whole chord (counted keydowns) and swallows the press's later events aimed elsewhere.
- **W-92** the field is re-checked after focus and right before inserting; a field changed right after gets its value back.
- **W-93** sign-in and step-up let the user pick among several authenticators.
- **W-94** recovery codes removed with the last authenticator by a trigger; recovery-only state shown and removable.
- **W-95** email codes stay visible while on; a failed turn-off during app setup is reported.
- **W-96** a Wren opened mid-install recognises the running installer and stays out of its way.
- **W-97** the extra OTP session is deleted in the recording transaction, or nothing is recorded.
- **W-98** one `safeNext` everywhere; redirects keep the query (`/app/link?code=…`).

Round 5 in brief:
- **W-74** bare program names checked against the PATH folders agents can write (`trust.ts`); pnpm global folder no longer writable.
- **W-75** browser identity, descriptions and snapshot in Playwright's isolated world (selector engine).
- **W-76** job records kept until the tree is gone; Windows Job Objects + parent-id walk; `--selftest --proctree` in CI.
- **W-77** typing bound to the checked node inside the engine; key presses guarded until delivered.
- **W-78** quit waits for confirmed shutdown (≤15 s).
- **W-79** confirmed as a Windows-only residual (no handle-relative API in Node): at most an empty file/folder outside, only by a concurrently running process that already has the user's access. Documented; 0.1.8 notes corrected.
- **W-80** popups owned by their task; close verified and retried.
- **W-81** agent-level stop mark (`agent_computers`) fences VM stop against starting runs.
- **W-82** a composer that starts a task holds (read-only) until the task page opens.
- **W-83** installer launch acknowledged; failed installs reported at the next start.
- **W-84** `useLive` loads serialized (`lib/client/coalesce.ts`).
- **W-85** schedules: every gap over a year checked when saving, and `nextRunAfter` spaces runs ≥15 min when the cron runs them.

Round 4 in brief:
- **W-63** program identity: path-qualified programs and unsafe environment assignments; absolute-only PATH.
- **W-64** substitutions inside double quotes.
- **W-65** browser identity held by the controller.
- **W-66** updater awaits confirmed shutdown.
- **W-67** Windows file-creation order; narrowed macOS helper runtime.
- **W-68** CLI follow-up cursor.
- **W-69** `finishRun` result decides VM shutdown.
- **W-70** verified cloud cleanup.
- **W-71** pairing lookups tied to their code.
- **W-72** composer clears the draft on send and restores it on failure.
- **W-73** `useLive({keepAll})` tracks `fetchedTop` and fills gaps in 1000-row pages.

Other shipped work:
- **UI polish.** Commit `58d84a8`, with `cd10478` fixing the focus box and page-switch speed. `components/ui.tsx` provides Button, ButtonLink, Menu, ConfirmProvider/useConfirm, Skeleton, Dialog, Tabs and toasts. Contrast tokens are in `globals.css`.
- **Collapsible panes.** Commit `c1b4422`. State lives in `lib/client/layout.ts` and is restored before paint by an inline `<head>` script in `app/layout.tsx`. Tailwind variants `rail:` and `details-off:`; shortcuts ⌘\ and ⇧⌘\.
- **Agent characters.** Commit `930f2e2`: 8 SVG characters × moods in `components/agent-character.tsx`, with data in `lib/characters.ts`. Stored in the agent's `icon` field.
- **Landing demo images** are in `apps/web/public/demo/rental-1..6.webp`.
- **Vercel Web Analytics** (2026-10-09, PR #2 from the Vercel Agent; restricted in re-audit #13, W-141/W-142): only on the public pages `/`, `/download`, `/legal` (`lib/analytics.ts` `ANALYTICS_PAGES`), never in the desktop window (`window.wren` present) and never on sign-in, auth or app pages: its script is fetched separately and runs with the page's full access (session cookies are readable by page scripts, and in the desktop the page reaches `window.wren`). `beforeSend` (`analyticsEvent`) drops any other page and the query string and hash. A loaded script stays in its document, so the site's links to `/login` and `/signup` are plain `<a>` (full page loads), and `SiteAnalytics` wraps every page: in a document that loaded the script (its own module state, not the SDK's `window.va`, which the script could delete, W-146) a non-public page is never drawn, and the document reloads instead. `Referrer-Policy: strict-origin` (next.config.ts) keeps private addresses out of the next page's referrer (W-141). Checked in the browser: script on `/`, none on `/login`; back from `/` to `/login` draws no password field in the old document (with `window.va` deleted too) and reloads clean; a `window.wren` stub loads nothing. The privacy page says so.

---

## Build, test, run

### Typecheck and unit tests
```bash
npm install
npm run typecheck                      # core + web + desktop
npm test                               # core 73 (+10 real-Chrome skipped), desktop 136 (+1 real-Chrome skipped), web 37
node qa/mfa-e2e.mjs                    # MFA bypass checks against the local stack (83; needs `npm run dev`; pauses the local mail container briefly)
node qa/mfa-ui.mjs                     # MFA in the real UI, headless Chrome (28)
npm test -w apps/desktop               # updater (mocked net.fetch/spawn, fake timers), trust, jobs, proctree
WREN_BROWSER_TEST=1 npx vitest run test/browser.test.ts   # in packages/core; headless Google Chrome
npx eslint src                         # in apps/web (0 errors, 9 existing warnings)
```
The real-Chrome browser tests (`WREN_BROWSER_TEST=1`, 10 tests incl. the W-75/77/80/165/173/179 attacks) need Google Chrome and run headless.

### Local stack
```bash
npx supabase start          # Docker; project_id "wren"; API :54321, DB :54322, Studio :54323, Mailpit :54324
npm run dev                 # web on http://localhost:5310 (Claude preview config name: wren-web)
```
- `apps/web/.env.development.local` (gitignored) holds the local env, including `WREN_TEST_MODEL=1`.
- Env names: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `DATABASE_URL`, `WREN_SECRETS_KEY`, `WREN_INTERNAL_SECRET`, `CRON_SECRET`, VAPID keys, `WREN_APP_URL`, `BLOB_READ_WRITE_TOKEN`, `VERCEL_OIDC_TOKEN`. Optional: `WREN_SELF_URL`, `PLATFORM_MODEL_USERS`, `WREN_SANDBOX_REGION`, `WREN_RELEASES_REPO`.
- Cloud runs from the local server still create real Vercel Sandbox VMs, through `VERCEL_OIDC_TOKEN`.
- The local DB's migration history is out of sync. Apply new SQL with `docker exec -i supabase_db_wren psql -U postgres < file.sql`.
- Local test accounts are in `.secrets/local-test-accounts.json` (owner account = owner@wren.test). **Use them only against localhost, never print them, and never create accounts in production.**
- A local `next start` needs the `NEXT_PUBLIC_*` variables exported at build time, plus `WREN_SELF_URL`.

### Desktop dev
```bash
cd apps/desktop && node scripts/build.mjs
WREN_DATA_DIR=<scratch dir> WREN_URL=http://localhost:5310 ../../node_modules/.bin/electron . --remote-debugging-port=9233
```
- `WREN_AUTOPAIR=1` prints `WREN_PAIR_CODE=…` to approve from a signed-in session, and links without the native account prompt (unpackaged builds only). For a quick local link, approve it in the DB: `update public.device_pairings set approved_at = now(), user_id = <owner id> where user_code = '<code>'`.
- A dev Wren protects its own files from its agents (W-128, W-133): `apps/desktop/dist-electron`, `apps/desktop/package.json` and every `node_modules` above it (the repo's included) are read-only to them, so an agent working on this repo through a dev Wren can't rebuild the desktop app or install packages; it can still edit source. Use the installed app for that work. Drive the window over CDP; `scripts/ui-smoke.mjs` shows how.
- The app holds a single-instance lock. Kill the old dev instance before relaunching, or the new one exits because port 9233 is busy.
- To test an update end to end: copy `dist-electron` into a scratch folder with a `package.json` whose version is older (e.g. 0.1.7) and `main: dist-electron/main.js`, symlink `node_modules`, and launch that folder. It downloads the real latest release. `--proxy-server=127.0.0.1:9` forces download errors (localhost bypasses the proxy, so the check still works). The local `/api/updates` may first answer 204 from Next's stale fetch cache; ask again.
- `node scripts/package.mjs mac|win` builds packages. Builds are unsigned: macOS is ad-hoc signed, Windows has no code signing.
- The user's own copy runs from `apps/desktop/release/mac-arm64/Wren.app`. Packaging locally overwrites it.

### End-to-end harnesses (NOT in the repo)
The E2E and UI scripts used for every audit round live in a previous session's scratchpad: `/private/tmp/claude-501/-Users-tamoghnakabi-studioproject/0ac17117-7f92-435c-b524-1046fe421157/scratchpad/`. That is temporary storage and may be gone.

| Script | Covers |
|---|---|
| `audit-e2e.mjs` | A–D |
| `reaudit-e2e.mjs` | E–K |
| `policy-e2e.mjs` | L–N |
| `revoke-e2e.mjs` | O |
| `round3-e2e.mjs` | R–V |
| `cloud-e2e.mjs` | P, Q, W, X (real VMs) |
| `engine-e2e.mjs`, `followup-e2e.mjs` | real Claude Code (uses the user's subscription) |
| `ui/` | `capture`, `interact` (14 checks), `axe`, `webfix` (W-71/72/73) |
| `upd/`, `conf/` | vitest with mocked electron |

All of them follow one pattern: log in with supabase-js as the owner test account, create `#script` tasks against hard-coded local agent IDs, and poll the `runs`/`events` tables. If they're gone, rebuild them on that pattern.

**Warn the user before running the desktop browser test (U): it opens a visible Chrome window.**

### Deploy and release
- **Web:** pushing to `main` auto-deploys Vercel project `wren-agents` (team `tamoghna1`, root `apps/web`, region syd1). Production: https://wren-agents.vercel.app.
  - `.vercelignore` keeps desktop build outputs out (they exceed the 100 MB limit).
  - Use `npx vercel` for the CLI. The Vercel MCP connector in this environment has no access to that team; check deploy status through the GitHub commit status instead.
- **Desktop release:**
  1. Bump `apps/desktop/package.json`.
  2. Add `releases/vX.Y.Z.md`.
  3. Commit and push, then push tag `vX.Y.Z`.
  - `desktop.yml` runs: core + desktop tests and desktop typecheck → mac (arm64 + x64, `--selftest`, `--selftest --proctree`, `--selftest --browser`, `--selftest --update`) and Windows (silent install + the same four self-tests) → `release-manifest.mjs` signs `wren-update.json` with secret `WREN_UPDATER_KEY` → `gh release create --prerelease`. `workflow_dispatch` with `publish: false` builds and self-tests a branch without releasing (use it to try Windows-only code first).
  - Every 0.x release is marked *pre-release* on GitHub. The update channel filters on plain `x.y.z` tags, never on that flag (filtering on it once broke updates).
  - Installed apps see a new release within about 5 minutes.
- **Supabase production:** project "Overdrive League", ref `luqeemaymnyybzyznmuh` (shared with another app; Wren tables live in `public`).
  - **MFA in production (done 2026-10-06):**
    - Dashboard → Auth → Emails: the "Magic link or OTP" template is the code-only one (`supabase/templates/verification-code.html`, subject "Your Wren verification code"). Email codes and step-up for accounts without MFA depend on it.
    - Security emails "Password changed", "MFA method added" and "MFA method removed" are on.
    - TOTP was already enabled (max 10 factors). There is no recovery-codes switch in the dashboard or Management API yet.
    - Email limit is 30 per hour project-wide; "Enable IP address forwarding" is on.
    - Order for any similar change: dashboard first, then the migration (the API calls `wren_mfa_state()`), then the web push.
  - Production migration names are `wren_0001`…`wren_0009`: repo 0006 = `wren_0008_run_invariants`, repo 0007 = `wren_0009_run_cleanup`. Repo 0008 = `wren_0010_agent_computers`, repo 0009 = `wren_0011_mfa`, repo 0010 = `wren_0012_mfa_hardening` (adds triggers on `auth.users` and `auth.mfa_factors`; `postgres` has TRIGGER on both in production, checked), repo 0011 = `wren_0013_mfa_send_state`, repo 0012 = `wren_0014_external_cleanups`.
  - pg_cron job `wren-tick` posts every minute to `/api/internal/cron` with a Bearer token from Vault secret `wren_cron_secret`.
  - Auth: Site URL https://wren-agents.vercel.app; email confirmation off; SMTP through Gmail.
  - Realtime broadcast from the DB needs a grant plus an insert policy on `realtime.messages` for `wren_api`.
- **GitHub:** public MIT repo `tamoghnakabi-wq/wren`. Push over HTTPS (`gh auth setup-git`); the local SSH key belongs to a different account.
- **Secrets** live in `.secrets/` (gitignored): DB password and URL, AES key, internal and cron secrets, VAPID keys, updater ed25519 key pair, local test accounts. Never commit, print or upload them.

---

## Known limitations and residual risks
- **Windows file races (W-67, W-79).** Node has no handle-relative open. A folder swapped for a junction at exactly the wrong moment can get an empty file or folder created outside (never written to), and a listing can show the swapped-in folder's names. Only a concurrently running process can swap, and on Windows that is an (approved) unsandboxed command with the user's full access anyway.
- **Windows process containment (W-76).** The Job Object is best-effort (built with Add-Type; Constrained Language Mode would block it, and the parent-id walk is then all there is). A deliberately escaping command (WMI, scheduled task) isn't contained; Windows has no sandbox. On macOS a command can leave its process group with setsid, but stays inside the Seatbelt sandbox.
- **Windows update shutdown (W-66).** Tested on macOS only; CI's Windows smoke test covers installation, not the shutdown timing.
- **Browser.** A page's own keyboard shortcuts act on whatever the page wires them to: a single key a site binds (a mail site's "#" to delete) is rated as the key it is (low), not by what the page does with it; only Enter/Space, unknown keys and Control/Alt/Meta chords are assessed against the focused element. A page still decides its own content (labels, text, attributes), and there's a small window between the final check and the click (Playwright's own hit-test). A key press into a cross-origin iframe can't be guarded from the page's document; focus is held on the checked node so the key doesn't go there. The key guard's listeners are added when the press starts, so a page's own capture listeners registered earlier run first and could stop Wren's from seeing an event; Wren then says it couldn't confirm the key reached the element (it can't undo what the page did with it).
- **Cron.** The deadline bounds when the cron answers and what it starts, not what already started: a stage still going at the deadline (`late`) may finish afterwards, if the platform lets it, and could overlap the next minute's call. Every such piece of work is scoped to its own task, computer or file and fenced as before (locks, leases, `xmin`), so repeating it is safe; provider calls already sent can't be called back.
- **Cloud VM stop (W-81).** A stop mark from a stopper that crashed mid-stop is honoured for up to 180 s (runs wait, then proceed).
- **W-68 edge case.** If a session switches between Wren's own agent and a CLI engine while a follow-up is in flight, that follow-up can be skipped.
- **MFA (Supabase limits).**
  - Supabase Auth v2.197 accepts a TOTP code again within its window (and the previous window's code), in any session: no replay protection (`qa/mfa-e2e.mjs` prints a NOTE).
  - Recovery codes are experimental. Production runs the same Auth version, but the Management API has no switch for them yet, so they may answer `mfa_recovery_codes_enroll_not_enabled` (the UI says so; the operator reset script is the fallback).
  - Email codes can't beat an attacker who controls the inbox: password reset goes there too. An authenticator app is the strong option.
  - A password-only attacker can enroll TOTP on an account without MFA (Supabase allows the first factor at `aal1`). The security notification email tells the owner; removing a factor they can't verify takes the operator script. Verifying a factor also signs out the account's other `aal1` sessions (Supabase behaviour).
  - Code checks call GoTrue from the server, so its per-IP verify limit (30 per 5 min) is shared by all users behind Vercel's egress addresses.
- **MFA (Wren's own triggers).**
  - The password trigger relies on Supabase Auth signing out every other session in the transaction that changes a password. Verified locally (v2.197) for the user endpoint and the Admin API (which signs out all sessions, so it can't change an email-code account's password at all). Supabase Auth has no rehash-on-sign-in; its optional hash encryption would rewrite `encrypted_password` at sign-in, but production hashes are plain bcrypt (checked 2026-10-06). Re-check if Supabase Auth is upgraded or that encryption is turned on.
  - Removing a factor while the same account is being deleted can deadlock (factor row vs user row); Postgres aborts one of the two and it can be retried. A factor demoted by UPDATE (no current Supabase path does that) wouldn't fire the recovery-code trigger.
  - A send Supabase is still processing after Wren's 15 s time limit (e.g. stuck email delivery) could still replace a later code: that code then fails and the user asks again (no bypass). The same goes for a request already on its way when the function was paused (the start deadline is checked as it goes out, not when Supabase receives it). If Wren's function dies between Supabase sending and marking the request delivered, that code can't be used; the user asks again after the minute.
  - Supabase Auth itself holds a database transaction while it emails (seen locally); Wren no longer does.
- **Process arguments and environments (macOS).** Agent commands can read the arguments and environment of every process of the same user (sysctl `KERN_PROCARGS2`, `pgrep -fl`; `ps` itself is blocked as a setuid program). Tested 2026-10-09: none of `(deny process-info* (target others))` or `(deny sysctl-read (sysctl-name "kern.procargs2"))` stops it. Wren keeps its own secrets out of both (W-121), but a secret the user put in a terminal's environment or a dev server's command line is visible to agent commands.
- **Scripts in the web page.** Supabase's browser client keeps the session in cookies page scripts can read, and in the desktop window the page can call `window.wren` (status, policy, pairing, updates). Nothing permission-raising goes through without a native prompt (W-142), but a script in the page (an XSS, or the hosting provider serving something else) could still act as the signed-in user on the web, turn permissions off, or trigger an update check. There is no Content-Security-Policy: Next's inline scripts need per-request nonces, which makes every page dynamic. Vercel Web Analytics runs on the public pages only, where a signed-in visitor's cookies are still readable to it, and a hostile script in a page can do anything in that document (fake a form, patch the router): Wren keeps private pages out of a document that loaded it, but only a separate origin would isolate it. Vercel already serves all of the app's code.
- **Cloud computers are the agent's own (W-156).** Agent commands in the cloud VM run as its default user, which has passwordless `sudo` (Wren's own browser setup uses it), so nothing inside the VM is out of an agent's reach, including the job records Wren uses to stop one task's commands (`~/.wren/jobs`). Per-task cleanup is therefore best effort against an agent that tampers with it; what ends everything is stopping the VM, which happens once no task of that agent is queued or running. A real boundary would need a VM per task.
- **Files in allowed folders that run later.** Everything inside an allowed folder is the agent's to change, including what tools run from a project when the user works on it outside Wren: `.git/hooks` and `.git/config` (hooks, fsmonitor, filters), `.envrc` (direnv), editor tasks (`.vscode/tasks.json`), package scripts, a project's `.claude/settings.json` (its hooks run once the user trusts the folder in Claude Code). Review an agent's changes before running a project outside Wren. Only the home-level places in `AUTORUN` and the folders on the user's PATH are protected; a startup file can still `source` a file inside an allowed folder, and a relocated config (`ZDOTDIR`, `CLAUDE_CONFIG_DIR`, XDG, git `include`) isn't followed.
- **Claude Code's own file tools** run in its process, outside any sandbox (it needs its Keychain, and a sandboxed process can't start the sandboxed commands it runs). Its deny rules and Wren's check keep them off Wren's data, Wren itself, credential stores and other engines' state, and Claude Code follows links before matching (tested), but a command swapping a checked path for a link in the instant between that check and the open could still redirect a read or write. Allowing a narrower folder than the whole home folder keeps such paths out of reach entirely.
- **Engine programs (W-187).** Wren vouches for the installer's native program as one whole: it doesn't follow what the program itself reads at run time beyond what is protected anyway (its settings and hooks are in AUTORUN, Claude Code runs `--restricted` with Wren's settings). Both official builds link only system libraries and have no rpaths (`otool -L`/`-l`, Claude Code 2.1.300, Grok 1.0.52), and Wren's environment allowlist keeps loader variables (`DYLD_*`, `NODE_OPTIONS`) out. A CLI installed any other way (npm, a version manager's shim, a Homebrew formula running Node) isn't started at all, so users of those must reinstall with the official installer.
- **Agent memory.** Notes an agent saved are given back to later tasks as notes, not instructions, but a note written while the agent was reading a hostile page can still mislead it later (a prompt injection that persists). Memories are listed on the agent's Memory tab, where the user can delete them.
- **Catastrophic commands** are recognised from the command's text (any quoting, options in any order); one assembled at run time (`$(…)`, variables, `eval`, base64) can't be, and gets the ordinary rating (high, as a program only known when it runs, or for deleting files). Neither can a delete whose targets come from elsewhere (`xargs rm -r`, PowerShell's `Get-ChildItem ~ | Remove-Item -Recurse`). Being text-based, the check also blocks harmless text that looks like such a delete (`echo "rm -r /usr"`).
- **Cloud browser daemon token** (W-169): the browser runs on the same VM user without Chromium's sandbox (`--no-sandbox`), so a page that broke out of its renderer could read the token file; it would already own the browser's profile then. The token stops what a page can do through ordinary requests.
- **Engine credentials.** An engine's own sign-in variables (e.g. `ANTHROPIC_API_KEY`, `XAI_API_KEY`, if the user set them in the environment Wren started from) stay visible to that engine's commands where Wren can't wrap them: Grok's commands, and Claude Code's on Windows. Nothing else from Wren's environment is.
- **Upstream CLI quirks.** Claude Code itself refuses commands that start with a long `sleep`. The user's `~/.grok` has `permission_mode = always-approve`; that is why approvals are enforced with the per-run plugin hook.
- **Out-of-date docs.** `docs/ARCHITECTURE.md` predates later rounds in places:
  - It says Windows commands need approval only "beyond read-only"; now every Windows command rates high.
  - It doesn't describe Claude `--restricted` + shell prefix, controller-held browser handles, or verified cloud cleanup.
- **Test gaps.** The round-5 E2E scripts (`r5-e2e.mjs`: desktop W-74/76/78 against the local stack; `w81-lock.mjs`, `w81-cloud.mjs`, `w81-mark.mjs`; `w82.mjs`, `w72.mjs`; `daemon/drive.mjs` runs the generated cloud daemon locally) live in session scratchpad `b435ac2e-…/scratchpad/` and will be lost like the earlier ones.
- **Release workflow.** GitHub Actions warns about Node 20 actions (`checkout@v4`, `setup-node@v4`), and `ubuntu-latest` moves to Ubuntu 26 on 2026-10-19.

## Remaining work / open items
- User actions:
  - Wren credits are switched off (see Models); before turning them back on, add a card for Vercel AI Gateway (they return 403 without one)
  - optionally install the desktop app into /Applications
  - optionally move SMTP to Resend once there's a domain
- Optional cleanups (not started; nothing is half-done):
  - bring `docs/ARCHITECTURE.md` up to date
  - move the E2E harnesses into `qa/` with configurable IDs and paths
  - update the GitHub Actions versions
  - code signing for macOS and Windows

## Conventions and traps
- Match the surrounding code: small comments that explain *why*, plain wording in user-facing messages.
- **Tailwind v4.**
  - Unlayered CSS beats utilities. Element defaults go in `@layer base`; custom helpers use `@utility`.
  - Single-column grids need `grid-cols-[minmax(0,1fr)]`.
- **Next.js.**
  - `next/script` `beforeInteractive` runs after first paint; use an inline `<head>` script for theme and layout.
  - A route-level `loading.tsx` made navigation slower; it was removed, and pages render their own skeletons.
  - Error boundaries get `{ error, retry }`.
  - Never import values from a `'use client'` module into server components; keep shared data in plain modules.
- **React.** Calling `desktop()` during render causes hydration mismatches; use `useDesktop()`.
- **Realtime.** Call `setAuth` before subscribing.
- **Playwright.** `page.evaluate`/`handle.evaluate` with a *string* doesn't receive handles; fetch the function as a handle first (see `describeElement`). `page.setContent` keeps the same `document`.
- **Process checks.** `pgrep -f "x"` matches its own probe command; use `ps -eo pid,args | grep -E "[0-9] x$"` or the `[x]` trick.
- **Approval.** Before deploying, releasing, or anything else outward-facing or irreversible, confirm with the user unless they've asked for it in the current task.
