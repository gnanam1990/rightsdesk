# RightsDesk — agent notes

Local build of the scoped-licensing product spec in `docs/build-pack/`. Zero runtime
dependencies; TypeScript on Node ≥22.6 via `--experimental-strip-types`.

## Commands

- `npm install --no-audit --no-fund --cache .npm-cache` — dev deps only (typescript, @types/node).
  npm's default cache dir may be outside the sandbox; keep `--cache .npm-cache`.
- `npm run dev` — one-process local stack: API + console + worker with the local
  checkout emulator (external providers stay disabled). `PORT=0` binds a free port.
- `npm test` — all suites (`node --test tests/*.test.ts`, type-stripped).
- `npm run typecheck` — `tsc --noEmit`.
- `npm run serve` — API + server-rendered console (`CHECKOUT_PROVIDER=local-emulator` for the
  emulator; anything else fails closed). `PORT`, `RIGHTSDESK_DB`, `RIGHTSDESK_ISSUER_KEYS`.
- `npm run worker` — outbox worker (settlement inspect, grant issuance, expiry scan).
- `npm run demo` — 20-step scripted acceptance journey; evidence into
  `build-progress/rightsdesk/evidence/`.
- `npm run pack-check` — build-pack checker.

## Layout

- `src/db/store.ts` + `src/db/migrations.ts` — `node:sqlite` store.
- `src/domain/` — canonical JSON + hashes, evaluator, grant/event signing, policy, validation.
- `src/providers/` — checkout + issuer adapters (local emulator + local issuer; external
  checkout fails closed by design).
- `src/api/` — JSON routers per domain, `ui.ts` console, auth/session/audit, idempotency.
- `src/worker.ts` — restart-safe outbox processing.
- `tests/helpers.ts` — `makeWorld()` test harness (memory or file DB, seeded roles, provider
  fault injection); temp dirs under `data/test-tmp` (sandbox-safe, gitignored).
- `build-progress/rightsdesk/` — STATUS.json + HANDOFF.md, keep current after every slice.

## Rules

- Payment never creates a license; only a seller-signed grant does.
- Decisions and receipts are immutable; grant status moves only through ordered signed events.
- Issuer private keys live under `data/issuer-keys/` (gitignored) — never commit secrets.
- Do not push, open PRs, or deploy from this workspace.
