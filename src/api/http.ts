import type { IncomingMessage, ServerResponse } from 'node:http';
import { ValidationError } from '../domain/validate.ts';

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const notFound = (what = 'resource') => new ApiError(404, 'not_found', `${what} not found`);
export const forbidden = (msg = 'insufficient scope') => new ApiError(403, 'forbidden', msg);
export const conflict = (msg: string) => new ApiError(409, 'conflict', msg);
export const unauthorized = () => new ApiError(401, 'unauthorized', 'authentication required');

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  user: import('../domain/types.ts').UserRow | null;
}

type Handler = (ctx: Ctx) => Promise<unknown> | unknown;
interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler }

const MAX_BODY = 1024 * 1024; // 1 MiB bound on extraction payloads

export class Router {
  routes: Route[] = [];
  add(method: string, path: string, handler: Handler) {
    const keys: string[] = [];
    const pattern = new RegExp('^' + path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\{([a-zA-Z_]+)\\\}/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, pattern, keys, handler });
  }
  get(p: string, h: Handler) { this.add('GET', p, h); }
  post(p: string, h: Handler) { this.add('POST', p, h); }

  async dispatch(ctx: Ctx): Promise<boolean> {
    for (const r of this.routes) {
      const m = r.pattern.exec(ctx.req.url!.split('?')[0]!);
      if (!m || r.method !== ctx.req.method) continue;
      m.slice(1).forEach((v, i) => { ctx.params[r.keys[i]!] = decodeURIComponent(v); });
      const out = await r.handler(ctx);
      if (out !== undefined) json(ctx.res, 200, out);
      return true;
    }
    return false;
  }
}

export function json(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

export function html(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

export function errorResponse(res: ServerResponse, e: unknown) {
  const err = e instanceof ApiError ? e
    : e instanceof ValidationError ? new ApiError(400, 'validation', e.message)
    : new ApiError(500, 'internal', 'internal error');
  if (!(e instanceof ApiError) && !(e instanceof ValidationError)) {
    console.error('[rightsdesk] unhandled error:', e);
  }
  json(res, err.status, { error: { code: err.code, message: err.message } });
}

export async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new ApiError(413, 'too_large', 'request body exceeds limit');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  const ct = req.headers['content-type'] ?? '';
  if (ct.includes('application/x-www-form-urlencoded')) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of new URLSearchParams(text)) {
      out[k] = out[k] === undefined ? v : Array.isArray(out[k]) ? [...(out[k] as string[]), v] : [out[k], v];
    }
    return out;
  }
  try { return JSON.parse(text); } catch { throw new ApiError(400, 'bad_json', 'request body is not valid JSON'); }
}

export function redirect(res: ServerResponse, location: string) {
  res.writeHead(303, { location });
  res.end();
}
