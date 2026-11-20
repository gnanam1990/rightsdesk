import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Startup smoke: `npm run dev` must boot the real UI/API + worker on a free
// port and shut down cleanly on SIGTERM. Isolated temp DB — no shared state.

const TMP_ROOT = join(process.cwd(), 'data', 'test-tmp');

function onceLine(cp: ChildProcess, match: RegExp, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${match}; saw: ${buf}`)), timeoutMs);
    cp.stdout!.on('data', (d) => {
      buf += String(d);
      const m = match.exec(buf);
      if (m) { clearTimeout(t); resolve(m[0]); }
    });
    cp.on('exit', (c) => { clearTimeout(t); reject(new Error(`child exited ${c} before ready; saw: ${buf}`)); });
  });
}

test('dev entrypoint boots server+worker, serves UI, exits cleanly', async () => {
  const dir = mkdtempSync(join(TMP_ROOT, 'dev-smoke-'));
  let cp: ChildProcess | undefined;
  try {
    cp = spawn(process.execPath, ['--experimental-strip-types', 'scripts/dev.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: '0', // OS-assigned free port
        RIGHTSDESK_DB: join(dir, 'dev.db'),
        RIGHTSDESK_ISSUER_KEYS: join(dir, 'issuer-keys'),
        WORKER_INTERVAL_MS: '50',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const line = await onceLine(cp, /http:\/\/localhost:(\d+)/);
    const port = Number(line.match(/:(\d+)$/)![1]);
    assert.ok(port > 0, 'dev server bound a port');

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json() as { ok: boolean }).ok, true);

    const login = await fetch(`http://127.0.0.1:${port}/login`);
    assert.equal(login.status, 200);
    assert.match(await login.text(), /RightsDesk/);

    const consoleRedirect = await fetch(`http://127.0.0.1:${port}/console`, { redirect: 'manual' });
    assert.equal(consoleRedirect.status, 303);
    assert.match(consoleRedirect.headers.get('location') ?? '', /login/);

    // Clean shutdown: SIGTERM → exit 0 within a few seconds.
    const exited = new Promise<number | null>((resolve) => cp!.on('exit', (c) => resolve(c)));
    cp.kill('SIGTERM');
    const code = await Promise.race([
      exited,
      new Promise<null>((_, rej) => setTimeout(() => rej(new Error('child did not exit on SIGTERM')), 8000)),
    ]);
    assert.equal(code, 0);
  } finally {
    if (cp && !cp.killed) cp.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
