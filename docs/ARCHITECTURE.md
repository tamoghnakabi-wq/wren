# Wren architecture

## Pieces

- **Web app (Vercel, `apps/web`)** — Next.js 16. Pages are client-rendered and read the user's rows straight from Supabase with RLS; Realtime `postgres_changes` keeps them live. Every write goes through an API route that authenticates the Supabase session (or a device token) and talks to Postgres as the `wren_api` role.
- **Database (Supabase)** — `profiles, agents, agent_memories, sessions, runs, events, approvals, artifacts, connections(+secrets), devices(+secrets), device_pairings, schedules, notifications, push_subscriptions, usage_records, run_live`. Secrets tables have RLS with no browser policies.
- **Files** — private Vercel Blob store; only served through `/api/files/[id]` after an ownership check, with `nosniff` and a sandboxing CSP.
- **Desktop app (`apps/desktop`)** — Electron window showing the hosted app, plus a background runner in the main process.

## A task's life

1. `POST /api/tasks` appends the user's message (with a per-run context block: time, memories, device) to the session's event log and creates a `run` (`runtime = cloud | desktop`).
2. **Cloud:** `/api/internal/tick` claims a lease on the run and executes the agent loop for ≤ ~4 minutes (Functions cap at 5). If work remains it invokes the next tick. A Supabase `pg_cron` job hits `/api/internal/cron` every minute to re-kick stalled runs, start due schedules and expire approvals.
3. **Desktop:** the server broadcasts a content-free `wake` on the device's private Realtime topic (plus a heartbeat fallback). The device claims the run over the device API and runs the same loop locally.
4. The loop (`packages/core/src/loop.ts`) is a resumable state machine over the event log: every model turn and tool call is persisted before it is acted on, so any process can pick the run up.

## Tools and safety

- Cloud tools run in the agent's persistent Vercel Sandbox (`wren-agent-<id>`); the model loop and all credentials stay in our functions. `web.fetch` runs server-side behind an SSRF guard.
- Desktop tools are confined to folders chosen in the desktop app (stored locally; the server can't change them). On macOS shell commands run under `sandbox-exec` (Seatbelt): writes only inside allowed folders/temp/caches, reads of `~/.ssh`, keychains, browser profiles, CLI credentials and Wren's own data are denied. Windows has no OS sandbox, so anything beyond read-only commands requires approval in balanced mode.
- Every tool call gets a risk level (`packages/core/src/policy.ts`); the agent's autonomy (careful / balanced / autonomous) decides which levels pause for approval. Some actions are never allowed (typing credentials, catastrophic commands). Approvals go to the inbox, push notifications and the desktop; a desktop can require approvals to be made on it.
- Engines (Claude Code, Grok Build) run their own loops; their tool calls are mirrored into the timeline and their permission prompts (Claude Code `--permission-prompt-tool`, Grok PreToolUse plugin hook) are answered by the same policy and approvals.

## Model access

`packages/core/src/models/*`: `ResponsesClient` (OpenAI API key, ChatGPT plan via Sign in with ChatGPT — `store:false`, `stream:true`, namespaced tools, no unsupported fields — xAI, Vercel AI Gateway), `AnthropicClient` (official SDK; append-only history so replayed thinking blocks stay valid, server-side context editing, adaptive thinking, refusal fallbacks), `ChatClient` (local OpenAI-compatible servers). Desktop runs that use API keys call `/api/device/runs/:id/model`, which streams the provider response back, so keys never leave the server. `resolveOpenAIRoute` applies the user's ChatGPT-plan vs API-key preference.

## Devices

Pairing is a device-code flow: the app gets a short code; the signed-in user approves it (one click inside the desktop app, or `/app/link`); the app polls once to receive a long-lived device token (stored with the OS keychain via `safeStorage`). The token is hashed server-side; unlinking revokes it immediately.

## Updates

Releases are built by GitHub Actions on native macOS/Windows runners and published to GitHub Releases with `wren-update.json`, signed per platform with an ed25519 key held in a repository secret. The app checks `/api/updates`, downloads the artifact, verifies the signature (public key compiled in) and checksum, then swaps the `.app` bundle after quitting (macOS) or runs the per-user NSIS installer silently (Windows).
