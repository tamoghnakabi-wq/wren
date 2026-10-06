# Wren: handoff notes for Claude Code

Wren is a personal AI agent platform (Dots / Grok-Bot style). Agents do real work on their own cloud computer (a Vercel Sandbox VM) or on the user's Mac/PC (desktop app). The user starts tasks from any device, watches each step live, approves sensitive actions and gets the results.

State as of 2026-10-06: `main` is in sync with `origin/main`; the last code commit is `0961512` (two-step sign-in, live in production with migration `wren_0011_mfa` and the dashboard settings below). The desktop app is at **0.1.10**. The five Codex security audits (W-1…W-85) are all fixed; see "Audit history" (W-79 is a documented Windows residual). No feature work is in progress.

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
apps/desktop      wren-desktop 0.1.9: Electron 44
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
supabase/migrations   0000…0007 (see Database)
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
- Files live in a private Vercel Blob store and are served only through `/api/files/[id]` after an ownership check.
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
3. **Desktop runs.**
   - The server broadcasts a content-free `wake` on the device's private Realtime channel; a 60 s heartbeat is the fallback.
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
- Long-lived daemons start with `runCommand({detached: true})` + `exec setsid … </dev/null`; otherwise the call hangs. In pkill patterns use `[b]rowser` so the pattern doesn't match its own `bash -lc` command line.
- GitHub is reachable only through the brokered `github.request` tool. No GitHub token is placed in the VM.

### Desktop app
- An Electron window shows the hosted web app (`WREN_URL`, default production). The main process runs `DeviceRunner`.
- **Pairing** is a device-code flow (`/api/device/pair/*`; the user approves on `/app/link` or with one click in the app). The device token is stored with `safeStorage` and hashed on the server.
- **Policy is local and re-read before every action** (`loadPolicy()`): allowed folders, shell, browser and screen switches, and remote approvals. The server can't change it. Reducing permissions kills running jobs and ends engine runs.
- **Engines.** The user's own CLIs are driven unmodified:
  - Claude Code via stream-json, `--permission-prompt-tool` (`mcp-approve.mjs`), `--restricted --tools … --strict-mcp-config`.
  - Grok Build via `grok agent stdio` (ACP), with a per-run plugin PreToolUse hook (`grok-hook.mjs`).
  - Engine tool calls are mirrored into the timeline by `TimelineWriter` and approved by the same policy.
  - After each completed engine turn a `reasoning` event `{engine, consumedSeq}` is appended. The next turn's prompt is `pendingAsks(events)`. A separate `reasoning` event `{engine, resumeId}` stores the CLI session; the resume lookup must require `resumeId`.
- **Updater.** It reads `/api/updates` (GitHub releases, revalidated every 300 s) and checks the manifest's ed25519 signature against the public key built into the app. It downloads to `<dataDir>/updates`.
  - All requests use Electron `net.fetch` (Chromium's stack: system proxy, OS certificate store) with `cache: 'no-store'`, not Node's fetch. A Windows user's updater sat on "Downloading…" forever; Settings showed "Downloading" for any available-but-not-ready state, which hid the real error (fixed in the web app for all versions, and in the desktop updater for 0.1.9+).
  - Bytes go to `<file>.<sha256[0:12]>.part` and resume with `Range` after a drop, a stall (no data for 2 min) or a restart. A finished but uninstalled download is reused. Failures retry after 5, then 15, then 60 minutes.
  - `check()` returns as soon as a download starts. State carries `received`/`total`/`retryAt`, and Settings shows progress, the error and the retry time. Builds ≤0.1.8 send none of these; the web row copes with both.
  - Install order:
    1. `runner.suspend()`
    2. close the browser
    3. `stopAllEngines()` + `stopAllJobs()`, all confirmed
    4. `verifiedCopy` into `<dataDir>/install-*`, re-hashing as it copies
  - macOS: a swap script runs after quit. Windows: the per-user NSIS installer runs silently (`/S`).
  - If agents can't be confirmed stopped, nothing is installed and `runner.resume()` is called.
  - The installer launch waits for the child's `spawn` event (W-83); on `error` Wren stays open with the reason and resumes agents. Before quitting it writes `<dataDir>/update-pending.json`; at the next start `cleanup()` reports an update that didn't install (plus `update-failed.txt` from the macOS swap script, which puts the old app back and reopens it on any failure), and that notice is kept on the next ready update.
- **Quitting** (W-78): `before-quit` is prevented until `runner.suspend()`, the browser, `stopAllEngines()` and `stopAllJobs()` are done (at most 15 s), then `app.quit()` runs again.
- `Wren --selftest` prints JSON and exits; CI uses it. `--selftest --update` also downloads the latest published release through the real updater path, and `--selftest --proctree` checks that something a command leaves running is found and stopped (Windows: ends with its Job Object, and is found by parent id without one). CI runs both on mac and Windows.

### Models (`packages/core/src/models`, `apps/web/src/lib/models.ts`)
- The model sources are: `openai`, `anthropic`, `xai`, `gateway` (Vercel AI Gateway), `platform` (operator's Gateway credits, only for `PLATFORM_MODEL_USERS`), `chatgpt` (desktop only), `local`, `claude-code`, `grok-build`.
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

- Some actions are always blocked: typing credentials or card data, and catastrophic commands (`rm -rf /`, `dd` to a disk, …).
- **Shell.** `parseShell` is a real lexer covering quotes, `$(…)`, backticks and process substitution. Substitutions inside double quotes are parsed recursively, and `$'…'` is decoded. Rules run against both the raw text and the normalized (unquoted) text.
- **Read-only commands.** A command counts as read-only only when all of these hold:
  - it is a bare name or lives in `/bin`, `/usr/bin` or `/sbin`
  - a bare name resolves (per the host's `trustedProgram`, `desktop/src/main/trust.ts`) to a program found on PATH **before** any folder agents can write (`agentWritable()` in sandbox.ts: allowed folders, temp, package caches), following links (W-74). Applied to ratings, engine approvals and crash replay; the cloud passes none. `~/Library/pnpm` itself is no longer writable to agents (only `Library/pnpm/store`), because PNPM_HOME is usually first on PATH.
  - any leading `VAR=` assignments are safe (`LC_*`, `LANG`, `TZ`, `TERM`, colour/pager variables)
  - option-sensitive commands have no dynamic arguments
- A program whose name is only known at run time (`$CMD`, `"$(…)"`, globs) rates **high**.
- **Platform and MCP ratings.**
  - Agent `PATH` keeps absolute entries only (`absolutePath`).
  - Cloud lowers medium to low (and "deletes files" from high to medium).
  - On Windows (no OS sandbox) every shell command rates at least high.
  - Engine shell commands are assessed as unsandboxed.
  - MCP calls rate high regardless of the server's own read-only hints.
- **Browser.**
  - Actions are assessed against the real target element (the focused one for `press`).
  - Everything that decides which node an action reaches runs in a Playwright selector engine registered with `contentScript: true` (`ENGINE` in controller.ts), i.e. Playwright's isolated world (W-75). Page scripts can't see its ids or replace the methods it uses. `page.evaluate` is NOT safe for this: Playwright's main-world helper uses the page's `Array.prototype.slice` and even `window.eval`, so a page can hijack any main-world evaluation (verified). The engine also builds the snapshot and element descriptions. Answers come back as a detached `<wren-data data-wren=JSON>` element read with `getAttribute`.
  - `registerSelectors(selectors)` must be called before the browser is launched (desktop host `controller()`, cloud daemon template).
  - Ids (`el-<uuid>`, same id for the same node via a WeakMap, max 500 per document) live only in the engine. Clicks go to `page.locator('wren=id <id>')`, so Playwright hit-tests in that world. Approved actions must still match label, role, inputType, url, href and `form`.
  - Typing (W-77) happens inside the engine: focus the node, refuse if focus moved (a field that hands focus to a password box), select all, `execCommand('insertText')`, which stays bound to that node even if a `beforeinput` handler moves focus. Only real input/textarea/contenteditable (labels are refused). Key presses: `arm` holds focus on the node (refocusing after any move, then blocking keys aimed elsewhere) until the key arrives; `disarm` reports a blocked key.
  - Each task owns a set of pages: its tab plus every popup opened from them (W-80). `close` closes all of them, keeps the record and returns `ok:false` if any stays open (cloud cleanup then stays pending; desktop closes the whole agent browser).
  - A targeted action that needs approval but has no element ID is refused.
- **Remote approvals off.** Pending approvals for that computer become `localOnly`, and only the desktop's native prompt (`window.wren.decideApproval`) can decide them.

### Two-step sign-in (MFA)
Opt-in per account. Rule in one place: `apps/web/src/lib/mfa-rules.ts` (`mfaStatus`) for the API, `public.wren_session_ok()` (migration 0009) for the database. Same logic:
- **Email codes on** (`public.mfa_email`): this session must have passed an email code (`public.mfa_session_checks`, joined to `auth.sessions`, so signing out ends it). Stays required even if a TOTP factor appears: a password-only attacker can enroll TOTP straight through the Auth API (tested), so the email rule is only lifted by turning email codes off from a verified session.
- **Else any verified Supabase factor** (TOTP, recovery codes): the JWT must be `aal2`.
- **Else** nothing more.

How each part works:
- **TOTP and recovery codes** are Supabase Auth factors, used from the browser (`supabase.auth.mfa.*`; recovery codes need `auth.experimental.recoveryCodes`, set in `lib/client/supabase.ts`). Supabase itself refuses at `aal1`: unenroll, a second factor, new recovery codes, password or email change (`insufficient_aal`, tested).
- **Email codes** are Supabase email OTPs: `lib/mfa.ts` calls `signInWithOtp` (code in the Magic Link template) and checks it with a throwaway `verifyOtp`, ending the extra session straight away. Wren only adds: a code counts only in the session that asked for it, 5 wrong tries per code, 1 send per minute and 5 per hour per user, a 10-minute window.
- **Enforcement:** `requireUser()` refuses unfinished sessions (403 `mfa_required`) unless the route passes `{ mfa: 'skip' }` (only `/api/me` and `/api/mfa/email/*`). Restrictive RLS policies "mfa" on all 14 browser-readable tables (Realtime too). The app layout redirects to `/auth/mfa?next=…` (path from the proxy's `x-wren-path`).
- **Step-up:** `requireUser(req, { stepUp: true })` needs a second step within `STEP_UP_SECONDS` (10 min). TOTP accounts: an `amr` entry `totp` or `mfa/recovery_code`. Others: an email code in this session. Used by account deletion, approving a device pairing, turning email codes off. In the browser, `api()` answers `step_up_required` with the "Confirm it's you" dialog (`components/app/step-up.tsx`) and retries once. Settings also asks before Supabase-direct changes (UI-level only: Supabase's own gate there is `aal2`).
- **UI:** `/auth/mfa` (TOTP, recovery code, email code), Settings → Security (`components/app/security-settings.tsx`). Removing the last authenticator removes the recovery codes first: Supabase leaves them as a lone factor otherwise, and still asks for `aal2`.
- **Lost phone and codes:** `scripts/mfa-reset-user.mjs` (operator only; Supabase Admin API with the secret key, which never goes in the web app).
- **Local stack:** `node scripts/local-auth-recovery-codes.mjs` after `supabase start` (the CLI has no config key for recovery codes yet). `config.toml` turns on TOTP, the code-only Magic Link template (`supabase/templates/verification-code.html`) and the security notification emails.

### Desktop confinement
- **macOS shell.** Commands run under `sandbox-exec` with `seatbeltProfile`:
  - writes only in allowed folders, temp and package caches
  - file contents under `/Users`, `/Volumes` and home unreadable, except allowed folders, toolchains and a few dotfiles
  - credential stores (`.ssh`, `.aws`, Keychains, …) and Wren's data folder never readable
- **Shell environment.** Commands are not login shells; PATH and toolchain variables come from `toolEnv()`.
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

---

## Build, test, run

### Typecheck and unit tests
```bash
npm install
npm run typecheck                      # core + web + desktop
npm test                               # core 57 (+6 real-Chrome skipped), desktop 26, web 14
node qa/mfa-e2e.mjs                    # MFA bypass checks against the local stack (44; needs `npm run dev`)
node qa/mfa-ui.mjs                     # MFA in the real UI, headless Chrome (21)
npm test -w apps/desktop               # updater (mocked net.fetch/spawn, fake timers), trust, jobs, proctree
WREN_BROWSER_TEST=1 npx vitest run test/browser.test.ts   # in packages/core; headless Google Chrome
npx eslint src                         # in apps/web (0 errors, 9 existing warnings)
```
The real-Chrome browser tests (`WREN_BROWSER_TEST=1`, 6 tests incl. the W-75/77/80 attacks) need Google Chrome and run headless.

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
- `WREN_AUTOPAIR=1` prints `WREN_PAIR_CODE=…` to approve from a signed-in session. Drive the window over CDP; `scripts/ui-smoke.mjs` shows how.
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
  - `desktop.yml` runs: core + desktop tests and desktop typecheck → mac (arm64 + x64, `--selftest`, `--selftest --proctree`, `--selftest --update`) and Windows (silent install + the same three self-tests) → `release-manifest.mjs` signs `wren-update.json` with secret `WREN_UPDATER_KEY` → `gh release create --prerelease`. `workflow_dispatch` with `publish: false` builds and self-tests a branch without releasing (use it to try Windows-only code first).
  - Every 0.x release is marked *pre-release* on GitHub. The update channel filters on plain `x.y.z` tags, never on that flag (filtering on it once broke updates).
  - Installed apps see a new release within about 5 minutes.
- **Supabase production:** project "Overdrive League", ref `luqeemaymnyybzyznmuh` (shared with another app; Wren tables live in `public`).
  - **MFA in production (done 2026-10-06):**
    - Dashboard → Auth → Emails: the "Magic link or OTP" template is the code-only one (`supabase/templates/verification-code.html`, subject "Your Wren verification code"). Email codes and step-up for accounts without MFA depend on it.
    - Security emails "Password changed", "MFA method added" and "MFA method removed" are on.
    - TOTP was already enabled (max 10 factors). There is no recovery-codes switch in the dashboard or Management API yet.
    - Email limit is 30 per hour project-wide; "Enable IP address forwarding" is on.
    - Order for any similar change: dashboard first, then the migration (the API calls `wren_mfa_state()`), then the web push.
  - Production migration names are `wren_0001`…`wren_0009`: repo 0006 = `wren_0008_run_invariants`, repo 0007 = `wren_0009_run_cleanup`. Repo 0008 = `wren_0010_agent_computers`, repo 0009 = `wren_0011_mfa`.
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
- **Browser.** A page still decides its own content (labels, text, attributes), and there's a small window between the final check and the click (Playwright's own hit-test). A key press into a cross-origin iframe can't be guarded from the page's document; focus is held on the checked node so the key doesn't go there.
- **Cloud VM stop (W-81).** A stop mark from a stopper that crashed mid-stop is honoured for up to 180 s (runs wait, then proceed).
- **W-68 edge case.** If a session switches between Wren's own agent and a CLI engine while a follow-up is in flight, that follow-up can be skipped.
- **MFA (Supabase limits).**
  - Supabase Auth v2.197 accepts a TOTP code again within its window (and the previous window's code), in any session: no replay protection (`qa/mfa-e2e.mjs` prints a NOTE).
  - Recovery codes are experimental. Production runs the same Auth version, but the Management API has no switch for them yet, so they may answer `mfa_recovery_codes_enroll_not_enabled` (the UI says so; the operator reset script is the fallback).
  - Email codes can't beat an attacker who controls the inbox: password reset goes there too. An authenticator app is the strong option.
  - A password-only attacker can enroll TOTP on an account without MFA (Supabase allows the first factor at `aal1`). The security notification email tells the owner; removing a factor they can't verify takes the operator script. Verifying a factor also signs out the account's other `aal1` sessions (Supabase behaviour).
  - Code checks call GoTrue from the server, so its per-IP verify limit (30 per 5 min) is shared by all users behind Vercel's egress addresses.
- **Upstream CLI quirks.** Claude Code itself refuses commands that start with a long `sleep`. The user's `~/.grok` has `permission_mode = always-approve`; that is why approvals are enforced with the per-run plugin hook.
- **Out-of-date docs.** `docs/ARCHITECTURE.md` predates later rounds in places:
  - It says Windows commands need approval only "beyond read-only"; now every Windows command rates high.
  - It doesn't describe Claude `--restricted` + shell prefix, controller-held browser handles, or verified cloud cleanup.
- **Test gaps.** The round-5 E2E scripts (`r5-e2e.mjs`: desktop W-74/76/78 against the local stack; `w81-lock.mjs`, `w81-cloud.mjs`, `w81-mark.mjs`; `w82.mjs`, `w72.mjs`; `daemon/drive.mjs` runs the generated cloud daemon locally) live in session scratchpad `b435ac2e-…/scratchpad/` and will be lost like the earlier ones.
- **Release workflow.** GitHub Actions warns about Node 20 actions (`checkout@v4`, `setup-node@v4`), and `ubuntu-latest` moves to Ubuntu 26 on 2026-10-19.

## Remaining work / open items
- User actions:
  - add a card for Vercel AI Gateway (Wren credits return 403 until then)
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
