# RightsDesk · Browser proof

Verifies the documented console journey in a real Chromium against `npm run dev`
— not mocked: the script spawns the actual dev entrypoint on an OS-assigned port
with a disposable database, seeds a licensed scenario through the JSON API, then
drives the UI.

## Run

```bash
npm install --no-audit --no-fund --cache .npm-cache   # adds dev dep playwright-core
node scripts/browser-check.mjs                      # exit 0 = all checks pass
```

Dependencies: Node ≥ 22.6, `playwright-core` (dev dep, **no** bundled browser —
the script resolves a real binary), and any Chromium/Chrome executable.

## Browser resolution

1. `RIGHTS_BROWSER=/path/to/chrome` — explicit override (any Chromium or Chrome).
2. Newest `~/Library/Caches/ms-playwright/chromium_headless_shell-*` — the
   standard macOS Playwright cache (`chromium_headless_shell-1254` verified on
   this host at `~/Library/Caches/ms-playwright/chromium_headless_shell-1254/
   chrome-headless-shell-mac-arm64/chrome-headless-shell`).
3. Common system Chrome paths (`/Applications/Google Chrome.app`, `/usr/bin/google-chrome`, …).

Ports and data are ephemeral: the dev server binds port 0, uses a throwaway
`data/test-tmp/browser-check-*` directory removed after the run.

## What it checks

- Sign-in page renders; a named **Sign in** control is keyboard-focusable.
- Publisher lands in the role-scoped work queue listing both intents.
- India case (`pub_jan20_in`): three-column scope table (Requested use / Offer
  scope / Grant scope); evaluating artifact `f…64` returns **allow** with the
  required credit line `Chart: Meridian Charts for The Chronicle`.
- Global case (`pub_global`): same artifact evaluates **deny** with visible
  reason codes (`edition_out_of_scope` / `territory_out_of_scope`).
- Reload persistence: refresh keeps the session cookie and the persisted
  decision — no re-login, no lost state.
- Permission/error visibility: editor role gets no evaluate/release forms; a
  direct POST attempt is refused and surfaced in-page (`cannot evaluate`).
- 320 px: case link reachable by Tab, Enter opens it, status + decision read
  first, and `document.scrollWidth ≤ 321` (no horizontal overflow).

Exit codes: `0` all checks pass · `1` check failure · `2` missing dependency ·
`3` browser could not launch (environment blocked it — replay on the host).

## Evidence

Per run: `build-progress/rightsdesk/evidence/browser/`
- `browser-evidence.json` — every check, pass/fail, detail, resolved binary.
- `01-allowed-india-case.png`, `02-denied-global-case.png`,
  `03-mobile-320-case.png`.

## Status

- Script delivered and self-verifying on this checkout.
- **Not yet executed to completion in the build sandbox**: macOS seatbelt
  denies Chromium's Mach-port bootstrap here (`bootstrap_check_in … Permission
  denied`), so the script exits 3. Replay on the host with the command above.
- Provider gates unchanged: the run uses the local checkout emulator and local
  issuer only; no paid or external calls, and `/dev/login` remains a dev-only
  role picker — real human auth is a separate boundary.

## Prior evidence

`scripts/demo.ts` covers the same allow/deny/review/expiry journey at the API
level (20 steps, 0 errors) — `build-progress/rightsdesk/evidence/demo-steps.json`.
