import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../db/store.ts';
import { all, now, one } from '../db/store.ts';
import { rid } from '../domain/ids.ts';
import type { UserRow } from '../domain/types.ts';
import { createSession, resolveUser, setSessionCookie } from './auth.ts';
import { errorResponse, readBody, redirect, Router, type Ctx } from './http.ts';
import { registryRoutes } from './routes/registry.ts';
import { offerIntentRoutes } from './routes/offers-intents.ts';
import { purchaseRoutes } from './routes/orders-grants.ts';
import { decisionRoutes } from './routes/decisions.ts';
import { releaseRoutes } from './routes/releases.ts';
import { eventRoutes } from './routes/events.ts';
import { reviewRoutes } from './routes/reviews.ts';
import type { CheckoutProvider } from '../providers/checkout.ts';
import { DisabledExternalCheckout } from '../providers/checkout.ts';
import type { LocalIssuerService } from '../providers/issuer.ts';

export interface AppDeps {
  db: Db;
  issuer?: LocalIssuerService;
  checkout?: CheckoutProvider;  // defaults to fail-closed external provider
  keyDir?: string;
}

// Merge route tables into one dispatcher.
export function buildApp(deps: AppDeps) {
  const checkout = deps.checkout ?? new DisabledExternalCheckout();
  const routers: Router[] = [
    registryRoutes(deps.db),
    offerIntentRoutes(deps.db),
    purchaseRoutes({ db: deps.db, checkout, issuer: deps.issuer }),
    decisionRoutes(deps.db),
    releaseRoutes(deps.db),
    eventRoutes(deps.db),
    reviewRoutes(deps.db),
  ];

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://local');
    const ctx: Ctx = {
      req, res, params: {}, query: url.searchParams, body: {},
      user: resolveUser(deps.db, req),
    };
    try {
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        ctx.body = await readBody(req);
      }
      for (const r of routers) {
        if (await r.dispatch(ctx)) return;
      }
      // built-in routes
      if (await builtin(ctx, deps)) return;
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'not_found', message: 'route not found' } }));
    } catch (e) {
      errorResponse(res, e);
    } finally {
      void started;
    }
  }
  return { handle };
}

async function builtin(ctx: Ctx, deps: AppDeps): Promise<boolean> {
  const { req, res } = ctx;
  const path = req.url!.split('?')[0]!;
  const db = deps.db;

  if (req.method === 'GET' && path === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'rightsdesk', time: now() }));
    return true;
  }
  if (req.method === 'GET' && path === '/whoami') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ user: ctx.user }));
    return true;
  }
  // Local dev login: pick a seeded user, get a session cookie. Explicitly a
  // development surface — not a production auth mechanism.
  if (req.method === 'GET' && path === '/dev/users') {
    const users = all<UserRow & { org_name: string; kind: string }>(db,
      `SELECT u.*, o.name AS org_name, o.kind FROM users u JOIN orgs o ON o.id = u.org_id ORDER BY o.kind, u.role`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(users));
    return true;
  }
  if (req.method === 'POST' && path === '/dev/login') {
    const body = ctx.body as Record<string, unknown>;
    const userId = typeof body.user_id === 'string' ? body.user_id : '';
    const user = one<UserRow>(db, 'SELECT * FROM users WHERE id = ?', userId);
    if (!user) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'not_found', message: 'user not found' } }));
      return true;
    }
    const token = createSession(db, user.id);
    setSessionCookie(res, token);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ user, token }));
    return true;
  }
  if (req.method === 'POST' && path === '/dev/logout') {
    res.setHeader('set-cookie', 'rd_session=; HttpOnly; Path=/; Max-Age=0');
    redirect(res, '/login');
    return true;
  }
  void rid;
  return false;
}
