// Normal-browser verification of the documented console journey.
//
// Boots `scripts/dev.ts` on an OS-assigned port with a disposable DB, seeds a
// licensed India-edition case and an out-of-scope GLOBAL intent through the
// JSON API, then drives a real Chromium through the console: sign in, open the
// case, evaluate the artifact, observe allow vs deny, reload persistence,
// role-restricted actions, and 320px keyboard navigation.
//
// Browser resolution order:
//   1. $RIGHTS_BROWSER  (explicit path to any Chromium/Chrome binary)
//   2. newest ~/Library/Caches/ms-playwright/chromium_headless_shell-*
//   3. common system Chrome locations
// Install playwright-core only: npm i -D playwright-core (no browser download).
//
// Run:  node scripts/browser-check.mjs
// Exit: 0 when every check passes; screenshots + browser-evidence.json under
//       build-progress/rightsdesk/evidence/browser/ (gitignored run-* dirs).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const TMP_ROOT = join(ROOT, 'data', 'test-tmp');
const EVIDENCE = join(ROOT, 'build-progress', 'rightsdesk', 'evidence', 'browser');
mkdirSync(TMP_ROOT, { recursive: true });
mkdirSync(EVIDENCE, { recursive: true });

// --- browser discovery ------------------------------------------------------
function browserPath() {
  if (process.env.RIGHTS_BROWSER && existsSync(process.env.RIGHTS_BROWSER)) {
    return process.env.RIGHTS_BROWSER;
  }
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (existsSync(cache)) {
    const vers = readdirSync(cache)
      .filter(d => d.startsWith('chromium_headless_shell-'))
      .sort().reverse();
    for (const v of vers) {
      for (const sub of readdirSync(join(cache, v))) {
        const p = join(cache, v, sub, 'chrome-headless-shell');
        if (existsSync(p)) return p;
      }
    }
  }
  for (const p of [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ]) if (existsSync(p)) return p;
  return null;
}

// --- tiny CDP-free driver via playwright-core -------------------------------
let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.error('playwright-core not installed: npm i -D playwright-core');
  process.exit(2);
}
const BROWSER = browserPath();
if (!BROWSER) {
  console.error('No Chromium binary found. Set RIGHTS_BROWSER=/path/to/chrome.');
  process.exit(2);
}
const stopChild = async () => {
  const exited = new Promise(r => child.on('exit', r));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise(r => setTimeout(r, 8000))]);
  rmSync(dir, { recursive: true, force: true });
};

// --- boot the dev stack -----------------------------------------------------
const dir = mkdtempSync(join(TMP_ROOT, 'browser-check-'));
const child = spawn(process.execPath, ['--experimental-strip-types', 'scripts/dev.ts'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: '0',
    RIGHTSDESK_DB: join(dir, 'dev.db'),
    RIGHTSDESK_ISSUER_KEYS: join(dir, 'issuer-keys'),
    WORKER_INTERVAL_MS: '80',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const base = await new Promise((resolve, reject) => {
  let buf = '';
  const t = setTimeout(() => reject(new Error('dev server did not start: ' + buf)), 20_000);
  child.stdout.on('data', d => {
    buf += String(d);
    const m = /http:\/\/localhost:(\d+)/.exec(buf);
    if (m) { clearTimeout(t); resolve(`http://localhost:${m[1]}`); }
  });
  child.on('exit', c => reject(new Error(`dev exited ${c}: ${buf}`)));
});

// --- seed the licensed scenario through the JSON API ------------------------
async function token(userId) {
  const r = await fetch(`${base}/dev/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: userId }),
  });
  return (await r.json()).token;
}
const TOK = Object.fromEntries(await Promise.all(
  ['usr_operator', 'usr_seller', 'usr_editor', 'usr_budget', 'usr_publisher']
    .map(async u => [u, await token(u)])));
async function api(userId, method, path, body) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOK[userId]}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const H = c => c.repeat(64);
const TERMS = {
  edition_set: ['IN'], channel_set: ['web'], territory_set: ['IN'],
  purposes: ['editorial'], attribution: 'Chart: Meridian Charts for The Chronicle',
  valid_from: '2030-01-01T00:00:00.000Z', valid_until: '2030-02-01T00:00:00.000Z',
  clauses: { credit_required: true, sublicensing: false, revocable: true },
};

await api('usr_operator', 'POST', '/sellers/sel_meridian/verify', {});
const a = await api('usr_seller', 'POST', '/sellers/sel_meridian/assets', {
  title: 'Chart A', revision: 1, content_sha256: H('d') });
const assetId = a.json.asset.id;
await api('usr_seller', 'POST', '/sellers/sel_meridian/assets', {
  asset_id: assetId, revision: 2, content_sha256: H('c'), predecessor_sha256: H('d') });
await api('usr_seller', 'POST', '/sellers/sel_meridian/assets', {
  asset_id: assetId, revision: 3, content_sha256: H('a'), predecessor_sha256: H('c') });
const offer = await api('usr_seller', 'POST', `/assets/${assetId}/offers`, {
  asset_revision: 3, terms_text: 'Meridian Charts standard chart license, schedule 1.',
  terms_schema: TERMS, price_atomic: 12500, asset_symbol: 'USDC', rail: 'local-emulator',
  expires_at: '2031-01-01T00:00:00.000Z' });
const offerId = offer.json.id;

async function licensedIntent(publicationId, over) {
  const i = await api('usr_editor', 'POST', '/publication-intents', {
    offer_id: offerId, publication_id: publicationId, edition: 'IN', channel: 'web',
    territory_set: ['IN'], purpose: 'editorial', attribution_text: TERMS.attribution,
    control_evidence_ref: 'controls://edition-routing/in-only',
    control_evidence_digest: H('e'), intended_at: '2030-01-20T12:00:00.000Z', ...over });
  const o = await api('usr_budget', 'POST', `/offers/${offerId}/orders`, {
    intent_id: i.json.id, price_cap_atomic: 50000 });
  for (let n = 0; n < 200; n++) { // wait for the dev worker to issue the grant
    const check = await api('usr_budget', 'GET', `/orders/${o.json.order.id}`);
    if (check.json.status === 'grant_active') return i.json.id;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`grant not issued for ${publicationId}`);
}
const indiaIntent = await licensedIntent('pub_jan20_in');
const globalIntent = await licensedIntent('pub_global', {
  edition: 'GLOBAL', territory_set: ['GLOBAL'],
  control_evidence_ref: 'controls://edition-routing/global',
  control_evidence_digest: H('9'), intended_at: '2030-01-25T12:00:00.000Z' });

// --- browser journey ---------------------------------------------------------
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ check: name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const shot = (page, name) => page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: true });

let browser;
try {
  browser = await chromium.launch({ executablePath: BROWSER });
} catch (e) {
  console.error('BROWSER_UNAVAILABLE — Chromium could not launch in this environment.');
  console.error(`binary: ${BROWSER}`);
  console.error(`reason: ${String(e).split('\n')[0]}`);
  console.error('Re-run on the host (see build-progress/rightsdesk/BROWSER.md).');
  await stopChild();
  process.exit(3);
}
try {
  // Publisher desktop journey: sign in → queue → case → evaluate → allow/deny.
  const desk = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await desk.newPage();
  await page.goto(`${base}/login`);
  check('login page renders', (await page.locator('h1').textContent())?.includes('RightsDesk'));

  const publisherBtn = page.locator('form', { has: page.locator('input[value="usr_publisher"]') }).locator('button');
  await publisherBtn.focus();
  check('keyboard focus lands on a named Sign in control',
    await page.evaluate(() => document.activeElement?.textContent?.includes('Sign in')));
  await page.keyboard.press('Enter');
  await page.waitForURL('**/console');
  check('publisher lands in work queue', page.url().endsWith('/console'));
  check('queue lists both intents',
    (await page.locator('main').textContent()).includes('pub_jan20_in')
    && (await page.locator('main').textContent()).includes('pub_global'));

  // India case: evaluate the registered artifact → allow with credit line.
  await page.locator(`a[href="/console/cases/${indiaIntent}"]`).click();
  await page.waitForURL(`**/cases/${indiaIntent}`);
  check('case shows three scope columns',
    (await page.locator('main').textContent()).includes('Requested use')
    && (await page.locator('main').textContent()).includes('Offer scope')
    && (await page.locator('main').textContent()).includes('Grant scope'));
  await page.locator('#ah').fill(H('f'));
  await page.locator('#ah').press('Enter');
  await page.waitForURL(`**/cases/${indiaIntent}?**`);
  const indiaText = await page.locator('main').textContent();
  check('IN/web/editorial evaluation allows', indiaText.includes('Decision recorded: allow'));
  check('required credit line visible', indiaText.includes('Chart: Meridian Charts for The Chronicle'));
  check('decision pill shows allow', await page.locator('.pill.allow').count() > 0);
  await shot(page, '01-allowed-india-case');

  // Global case: same artifact, out of scope → deny with reason codes.
  await page.goto(`${base}/console/cases/${globalIntent}`);
  await page.locator('#ah').fill(H('f'));
  await page.locator('#ah').press('Enter');
  await page.waitForURL(`**/cases/${globalIntent}?**`);
  const globText = await page.locator('main').textContent();
  check('GLOBAL evaluation denied', globText.includes('Decision recorded: deny'));
  check('deny reason codes visible',
    globText.includes('edition_out_of_scope') || globText.includes('territory_out_of_scope'));
  await shot(page, '02-denied-global-case');

  // Reload persistence: session + persisted decision survive a refresh.
  await page.reload();
  const afterReload = await page.locator('main').textContent();
  check('reload keeps session and decision',
    !page.url().includes('/login') && afterReload.includes('edition_out_of_scope'));

  // Editor permission surface: no evaluate/release forms, controls form present,
  // direct POST is refused with an in-page error.
  const ed = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const ep = await ed.newPage();
  await ep.goto(`${base}/login`);
  await ep.locator('form', { has: ep.locator('input[value="usr_editor"]') }).locator('button').click();
  await ep.waitForURL('**/console');
  await ep.goto(`${base}/console/cases/${indiaIntent}`);
  const epText = await ep.locator('main').textContent();
  check('editor sees no evaluate/release form',
    !epText.includes('Register release artifact') && await ep.locator('#ah').count() === 0);
  check('editor sees controls declaration form', await ep.locator('#cr').count() === 1);
  const deniedPost = await ep.evaluate(async (id) => {
    const r = await fetch(`/console/cases/${id}/evaluate`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `artifact_hash=${'f'.repeat(64)}`,
    });
    return { status: r.status, loc: r.headers.get('location') };
  }, indiaIntent);
  check('editor evaluate attempt refused visibly',
    deniedPost.status === 303 && decodeURIComponent(deniedPost.loc ?? '').includes('cannot evaluate'),
    `→ ${deniedPost.status} ${(deniedPost.loc ?? '').slice(0, 70)}`);

  // 320px task check: queue → case link reachable by Tab, decision readable.
  const mob = await browser.newContext({ viewport: { width: 320, height: 640 } });
  const mp = await mob.newPage();
  // Reuse publisher session cookie for the mobile context.
  const cookies = await desk.cookies();
  await mob.addCookies(cookies.map(c => ({ ...c, url: base })));
  await mp.goto(`${base}/console`);
  check('320px queue shows case link',
    await mp.locator(`a[href="/console/cases/${indiaIntent}"]`).isVisible());
  let tabs = 0, focusedCase = false;
  for (; tabs < 24; tabs++) {
    await mp.keyboard.press('Tab');
    if (await mp.evaluate((id) => document.activeElement?.getAttribute('href') === `/console/cases/${id}`, indiaIntent)) {
      focusedCase = true; break;
    }
  }
  check('case link reachable by keyboard at 320px', focusedCase, `${tabs} tabs`);
  await mp.keyboard.press('Enter');
  await mp.waitForURL(`**/cases/${indiaIntent}`);
  const mobText = await mp.locator('main').textContent();
  check('320px case shows status and decision first',
    mobText.includes('allow') && mobText.includes('Decisions'));
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth);
  check('no horizontal overflow at 320px', overflow <= 321, `scrollWidth=${overflow}`);
  await shot(mp, '03-mobile-320-case');

  await desk.close(); await ed.close(); await mob.close();
} finally {
  await browser.close();
  await stopChild();
}

writeFileSync(join(EVIDENCE, 'browser-evidence.json'), JSON.stringify({
  base, browser: BROWSER, ranAt: new Date().toISOString(), results,
}, null, 2));
const fails = results.filter(r => !r.ok);
console.log(`\n${results.length} checks · ${fails.length} failures`);
process.exit(fails.length ? 1 : 0);
