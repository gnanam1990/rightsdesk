# RightsDesk

Scoped licensing decisions for newsroom chart re-use — local build of the spec in
`docs/build-pack/`. Zero runtime dependencies; TypeScript on Node ≥ 22.6 via
`--experimental-strip-types`; durable state in `node:sqlite`.

Payment never creates a license — only a seller-signed grant does. See
`build-progress/rightsdesk/` for module status and evidence.

## Quick start

```bash
npm install --no-audit --no-fund --cache .npm-cache   # dev deps only (typescript, @types/node)
npm run dev                                          # API + console + worker on :8787
```

Then open `http://localhost:8787/login` and sign in as a seeded role (editor,
budget holder, rights officer, publisher, seller agent, operator).

`npm run dev` starts everything a local checkout needs in one process:

- the JSON API and the server-rendered console (`/console`, `/console/cases/{id}`,
  `/console/inbox`, `/console/catalog`),
- the outbox worker (settlement inspect, grant issuance, expiry scan),
- the **local checkout emulator** — external providers are disabled here; any other
  configuration fails closed by design.

Environment knobs: `PORT` (0 = free port), `RIGHTSDESK_DB`, `RIGHTSDESK_ISSUER_KEYS`,
`WORKER_INTERVAL_MS`, `WORKER=0` (worker off). `Ctrl-C` shuts down cleanly.

## Other entry points

| Command | What it runs |
|---|---|
| `npm run serve` | API + console only (`CHECKOUT_PROVIDER=local-emulator` for the emulator) |
| `npm run worker` | outbox worker as its own process |
| `npm test` | all suites (`node --test tests/*.test.ts`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run demo` | 20-step scripted acceptance journey → `build-progress/rightsdesk/evidence/` |
| `npm run pack-check` | build-pack checker |

## API surface (selected)

`POST /sellers/{id}/assets` · `POST /assets/{id}/offers` · `POST /publication-intents`
· `GET /intents/{id}/offers` · `POST /offers/{id}/orders` · `POST /issuers/{id}/grants`
· `POST /intents/{id}/evaluate` · `GET /decisions/{id}` · `POST /publications/{id}/confirm`
· `POST /issuers/{id}/grant-events` · `GET /grants/{id}/impacts` · `GET /cases/{id}/export`
· `POST /reviews` · `GET /inbox`

Bearer sessions for the API: `POST /dev/login {"user_id":"usr_editor"}` → token.

## Status

All eight build-pack modules implemented and proven locally (32 tests, clean
typecheck, scripted acceptance journey, clean-checkout proof). External
integrations — Kite checkout, a participating rights holder, a managed CMS hook —
are **not proven**; every in-product path runs through the local emulator and
local issuer. No paid calls, transfers or external publication happen in this
workspace.
