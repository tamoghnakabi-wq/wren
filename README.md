# Wren

Personal AI agents that do real work — on their own cloud computer or on your Mac/PC — and that you control from anywhere: start tasks from your phone, watch every step live, approve sensitive actions, get results while you're away.

- **Web + mobile (PWA):** landing page, downloads, and the full app — agents, live task timeline, approvals, files, schedules, connections, usage, settings, push notifications.
- **macOS + Windows desktop app:** lets agents work on your own computer (inside folders you allow), runs tasks sent from your phone, and uses the AI plans you already have.
- **Cloud agents:** every agent gets a persistent Vercel Sandbox VM with a terminal, files and a real Chromium browser, so work continues while your computer is off.

## Use the AI plans you already pay for — within each provider's rules

| Plan | How Wren uses it | Where |
| --- | --- | --- |
| ChatGPT Plus / Pro | OpenAI's official **Sign in with ChatGPT** (dynamic client registration for open-source, locally hosted apps; loopback + PKCE; requests use your plan through the Responses API) | Desktop app |
| Claude Pro / Max | Anthropic's own, unmodified **Claude Code** CLI, signed in by you; Wren answers its permission prompts with Wren approvals | Desktop app |
| SuperGrok / X Premium | xAI's official **Grok Build** CLI over its documented ACP mode, signed in by you; a per-run Grok plugin hook routes every tool call through Wren approvals | Desktop app |
| Local models | Any OpenAI-compatible server (LM Studio, Ollama, …) | Desktop app |
| API keys (OpenAI, Anthropic, xAI, Vercel AI Gateway) | Encrypted server-side, never sent to an agent's computer | Cloud + desktop |

Wren never scrapes sessions, reuses another app's OAuth client, or stores Claude/xAI credentials. Today no provider lets a hosted third-party cloud use a consumer plan (OpenAI requires partner approval for hosted apps; Anthropic forbids it; xAI hasn't published a way), so cloud agents use API keys. Users choose and can switch between their ChatGPT plan and an OpenAI API key in Settings.

## Repository

```
packages/core   Agent runtime shared by cloud and desktop: resumable loop, tool catalog,
                risk policy + approvals, model adapters (OpenAI Responses incl. ChatGPT-plan
                constraints, Anthropic Messages via the official SDK, OpenAI-compatible chat),
                browser controller, SSRF-guarded fetch.
apps/web        Next.js 16 app on Vercel: site, PWA, API routes, cloud runner (time-boxed
                "ticks" + Vercel Sandbox tool host), device API, cron/scheduler endpoint.
apps/desktop    Electron app: pairing, device runner, local tool host (macOS Seatbelt-sandboxed
                shell, folder-scoped files, visible Chrome, screen capture), Sign in with ChatGPT,
                Claude Code / Grok Build engines, signed self-updater.
supabase        Postgres schema (RLS reads + Realtime; all writes through the API role).
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how runs, approvals, devices and updates work.

## Development

```bash
npm install
npx supabase start            # local Postgres/Auth/Realtime (Docker)
npm run dev                   # web on http://localhost:5310 (apps/web/.env.development.local)
npm test -w packages/core     # runtime + policy tests
cd apps/desktop && npm run dev   # desktop app against the local web app
```

Desktop packages: `node scripts/package.mjs mac|win` in `apps/desktop`. Pushing a `v*` tag builds macOS (arm64 + x64) and Windows (x64) on GitHub Actions and publishes a release with an ed25519-signed `wren-update.json`.

## License

MIT
