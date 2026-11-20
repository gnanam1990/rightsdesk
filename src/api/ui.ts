import type { IncomingMessage, ServerResponse } from 'node:http';
import { all, now, one, type Db } from '../db/store.ts';
import { rid } from '../domain/ids.ts';
import { evaluate } from '../domain/evaluator.ts';
import type {
  DecisionRow, IntentRow, PublicationRow, UserRow,
} from '../domain/types.ts';
import { audit, createSession, resolveUser, setSessionCookie } from './auth.ts';
import { html, redirect, ApiError } from './http.ts';
import { persistDecision } from './routes/decisions.ts';
import { confirmPublication } from './routes/releases.ts';

// Server-rendered role-aware console (UI-SPEC). Native controls only — the
// whole case flow works without JavaScript; every status carries text.

const CSS = `
:root{--ink:#14161a;--mut:#5b6470;--line:#dde1e6;--bg:#f4f5f7;--card:#fff;
--acc:#0d6e63;--acc-ink:#fff;--ok:#0d6e3a;--deny:#b3261e;--warn:#8a5a00;--info:#4a5568}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);
font:15px/1.5 -apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif}
a{color:var(--acc)}code,.mono{font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;
overflow-wrap:anywhere;word-break:break-all}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,
textarea:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.topbar{display:flex;align-items:center;gap:16px;background:#14161a;color:#fff;
padding:0 24px;height:56px}
.topbar .brand{font-weight:650;letter-spacing:.02em;text-decoration:none;color:#fff}
.topbar nav{display:flex;gap:4px;flex:1}
.topbar nav a{color:#c8ced8;text-decoration:none;padding:6px 10px;border-radius:6px;font-size:14px}
.topbar nav a[aria-current=page]{color:#fff;background:#ffffff22}
.topbar .who{font-size:13px;color:#c8ced8}
.topbar .who b{color:#fff;font-weight:600}
.topbar form{margin:0}
.btn{background:var(--acc);color:var(--acc-ink);border:0;border-radius:6px;
padding:7px 14px;font:600 13.5px/1.4 inherit;cursor:pointer}
.btn:hover{filter:brightness(1.08)}.btn:active{transform:translateY(1px)}
.btn.ghost{background:transparent;color:#c8ced8;border:1px solid #ffffff3a}
.btn.ghost:hover{color:#fff}
.btn.secondary{background:#e4e9ee;color:var(--ink)}
main{max-width:1120px;margin:0 auto;padding:28px 24px 64px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:0 0 10px;
text-transform:uppercase;letter-spacing:.06em;color:var(--mut)}
.lede{color:var(--mut);margin:0 0 22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;
padding:18px 20px;margin-bottom:16px}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.05em;
color:var(--mut);padding:6px 10px;border-bottom:1px solid var(--line)}
td{padding:8px 10px;border-bottom:1px solid #edf0f3;vertical-align:top}
tr:last-child td{border-bottom:0}
.pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;
font-weight:600;background:#e4e9ee;color:var(--info)}
.pill.allow,.pill.released,.pill.grant_active,.pill.active,.pill.verified{background:#dff2e5;color:var(--ok)}
.pill.deny,.pill.blocked,.pill.revoked,.pill.expired{background:#fbe3e1;color:var(--deny)}
.pill.review_required,.pill.paid_awaiting_grant,.pill.payment_unknown,.pill.rights_review{background:#f8ecd2;color:var(--warn)}
.cmp td:first-child{color:var(--mut);font-size:12.5px;text-transform:uppercase;
letter-spacing:.04em;width:150px}
.cmp .miss{background:#fbe3e1}.cmp .hit{background:#dff2e5}
.dim{display:flex;gap:10px;align-items:baseline;padding:6px 0;border-bottom:1px solid #edf0f3;font-size:13.5px}
.dim:last-child{border-bottom:0}.dim b{min-width:150px;font-weight:600}
.dim .st{font-size:12px;font-weight:700}
.dim .st.satisfied{color:var(--ok)}.dim .st.violated{color:var(--deny)}
.dim .st.unknown,.dim .st.unsupported{color:var(--warn)}
label{display:block;font-size:13px;font-weight:600;margin:12px 0 4px}
input,select,textarea{width:100%;max-width:420px;padding:7px 9px;border:1px solid var(--line);
border-radius:6px;font:inherit;font-size:14px;background:#fff}
fieldset{border:0;padding:0;margin:0}
.hint{color:var(--mut);font-size:12.5px;margin-top:2px}
.notice{background:#dff2e5;border:1px solid #b6dfc2;color:var(--ok);padding:10px 14px;
border-radius:8px;margin-bottom:16px;font-size:14px}
.warn-note{background:#f8ecd2;border:1px solid #ecd9a8;color:#6b4a00;padding:10px 14px;
border-radius:8px;margin-bottom:16px;font-size:14px}
.err{background:#fbe3e1;border:1px solid #f0b8b4;color:var(--deny);padding:10px 14px;
border-radius:8px;margin-bottom:16px;font-size:14px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.kv{display:grid;grid-template-columns:150px 1fr;gap:4px 12px;font-size:14px}
.kv dt{color:var(--mut);font-size:13px}.kv dd{margin:0}
tr.dec-head td{background:#f7f8fa;font-weight:600}
@media (max-width:760px){.grid2{grid-template-columns:1fr}.topbar{flex-wrap:wrap;height:auto;
padding:10px 16px}main{padding:18px 14px 48px}.cmp td:first-child{width:110px}
.card{overflow-x:auto}table{font-size:13px}td,th{padding:6px 8px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>
  )[c]!);
}
const pill = (s: unknown) => `<span class="pill ${esc(s)}">${esc(s)}</span>`;
const short = (h?: string | null) => h ? `<code title="${esc(h)}">${esc(h.slice(0, 10))}…</code>` : '—';

function page(u: UserRow | null, title: string, body: string, current = ''): string {
  const nav = u ? `
    <nav aria-label="Console">
      <a href="/console"${current === 'queue' ? ' aria-current="page"' : ''}>Queue</a>
      <a href="/console/inbox"${current === 'inbox' ? ' aria-current="page"' : ''}>Inbox</a>
      <a href="/console/catalog"${current === 'catalog' ? ' aria-current="page"' : ''}>Catalog</a>
    </nav>
    <span class="who"><b>${esc(u.display_name)}</b> · ${esc(u.role)} · ${esc(u.org_id)}</span>
    <form method="post" action="/console/logout"><button class="btn ghost" type="submit">Sign out</button></form>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · RightsDesk</title><style>${CSS}</style></head><body>
<header class="topbar"><a class="brand" href="/console">RightsDesk</a>${nav}</header>
<main>${body}</main></body></html>`;
}

const notice = (ctx: { query: URLSearchParams }) => {
  const n = ctx.query.get('notice'); const e = ctx.query.get('error');
  return (n ? `<p class="notice" role="status">${esc(n)}</p>` : '')
    + (e ? `<p class="err" role="alert">${esc(e)}</p>` : '');
};

export function uiRouter(db: Db) {
  const userOf = (req: IncomingMessage) => resolveUser(db, req);
  const need = (req: IncomingMessage, res: ServerResponse): UserRow | null => {
    const u = userOf(req);
    if (!u) redirect(res, '/login');
    return u;
  };
  const intent = (id: string) => one<IntentRow>(db, 'SELECT * FROM intents WHERE id=?', id);

  return async function handle(
    req: IncomingMessage, res: ServerResponse, reqBody: unknown,
  ): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://local');
    const path = url.pathname;
    const ctx = { query: url.searchParams };
    const body = async () => (reqBody ?? {}) as Record<string, string>;

    if (req.method === 'GET' && path === '/') {
      redirect(res, userOf(req) ? '/console' : '/login'); return true;
    }

    if (req.method === 'GET' && path === '/login') {
      const users = all<UserRow & { org_name: string; kind: string }>(db,
        `SELECT u.*, o.name AS org_name, o.kind FROM users u JOIN orgs o ON o.id=u.org_id ORDER BY o.kind, u.role`);
      const rows = users.map(x => `<tr>
        <td><b>${esc(x.display_name)}</b></td><td>${esc(x.role)}</td>
        <td>${esc(x.org_name)} <code>${esc(x.org_id)}</code></td>
        <td><form method="post" action="/console/login"><input type="hidden" name="user_id" value="${esc(x.id)}">
        <button class="btn secondary" type="submit">Sign in</button></form></td></tr>`).join('');
      html(res, 200, page(null, 'Sign in', `
        <h1>RightsDesk</h1>
        <p class="lede">Rights licensing workspace — local development sign-in. Pick the role you are rehearsing.</p>
        <div class="card"><table><thead><tr><th>User</th><th>Role</th><th>Organization</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>`));
      return true;
    }

    if (req.method === 'POST' && path === '/console/login') {
      const b = await body();
      const u = one<UserRow>(db, 'SELECT * FROM users WHERE id=?', b.user_id ?? '');
      if (!u) { html(res, 404, page(null, 'Sign in', '<p class="err">Unknown user.</p>')); return true; }
      setSessionCookie(res, createSession(db, u.id));
      redirect(res, '/console');
      return true;
    }
    if (req.method === 'POST' && path === '/console/logout') {
      res.setHeader('set-cookie', 'rd_session=; HttpOnly; Path=/; Max-Age=0');
      redirect(res, '/login');
      return true;
    }

    // ---- work queue ------------------------------------------------------
    if (req.method === 'GET' && path === '/console') {
      const u = need(req, res); if (!u) return true;
      const scoped = u.role === 'operator' ? '' : 'AND i.buyer_org_id=?';
      const intents = all<IntentRow & { offers: number; dec: string | null }>(db,
        `SELECT i.*, (SELECT result FROM decisions d WHERE d.intent_id=i.id ORDER BY d.evaluated_at DESC LIMIT 1) AS dec
         FROM intents i WHERE 1=1 ${scoped} ORDER BY i.created_at DESC`,
        ...(u.role === 'operator' ? [] : [u.org_id]));
      const pubs = all<PublicationRow>(db,
        u.role === 'operator' ? 'SELECT * FROM publications ORDER BY created_at DESC'
          : 'SELECT * FROM publications WHERE buyer_org_id=? ORDER BY created_at DESC', u.org_id);
      const sellerView = u.role === 'seller_agent';
      const orders = sellerView ? all(db,
        `SELECT o.*, i.publication_id FROM orders o LEFT JOIN intents i ON i.id=o.intent_id
         WHERE o.offer_id IN (SELECT id FROM offers WHERE seller_id IN (SELECT id FROM sellers WHERE org_id=?))
         ORDER BY o.created_at DESC`, u.org_id) : [];

      const intentRows = intents.map(i => `<tr>
        <td><a href="/console/cases/${esc(i.id)}"><code>${esc(i.publication_id)}</code></a></td>
        <td>${esc(i.edition)} · ${esc(i.channel)}</td><td><code>${esc(JSON.parse(i.territory_set).join(','))}</code></td>
        <td>${pill(i.status)}</td><td>${i.dec ? pill(i.dec) : '—'}</td></tr>`).join('');
      const pubRows = pubs.map(p => `<tr>
        <td><a href="/console/releases/${esc(p.id)}"><code>${esc(p.id)}</code></a></td>
        <td>${short(p.artifact_hash)}</td><td>${pill(p.status)}</td></tr>`).join('');
      const orderRows = orders.map((o: any) => `<tr>
        <td><code>${esc(o.id)}</code></td><td><code>${esc(o.publication_id ?? '—')}</code></td>
        <td>${pill(o.status)}</td><td>${o.payment_ref ? `<code>${esc(o.payment_ref)}</code>` : '—'}</td></tr>`).join('');

      html(res, 200, page(u, 'Queue', `${notice(ctx)}
        <h1>Work queue</h1>
        <p class="lede">Your permitted surface — intents, releases and payments in scope for ${esc(u.org_id)}.</p>
        ${sellerView ? `
        <section class="card"><h2>Orders to your catalog</h2>
          ${orders.length ? `<table><thead><tr><th>Order</th><th>Publication</th><th>Status</th><th>Payment ref</th></tr></thead><tbody>${orderRows}</tbody></table>` : '<p class="hint">No orders yet.</p>'}
        </section>` : `
        <section class="card"><h2>Publication intents</h2>
          ${intents.length ? `<table><thead><tr><th>Publication</th><th>Edition · channel</th><th>Territory</th><th>Status</th><th>Latest decision</th></tr></thead><tbody>${intentRows}</tbody></table>` : '<p class="hint">No intents yet.</p>'}
        </section>
        <section class="card"><h2>Releases</h2>
          ${pubs.length ? `<table><thead><tr><th>Release</th><th>Artifact</th><th>Status</th></tr></thead><tbody>${pubRows}</tbody></table>` : '<p class="hint">No releases yet.</p>'}
        </section>`}`, 'queue'));
      return true;
    }

    // ---- inbox -----------------------------------------------------------
    if (req.method === 'GET' && path === '/console/inbox') {
      const u = need(req, res); if (!u) return true;
      const op = u.role === 'operator';
      const awaiting = all(db,
        `SELECT o.*, i.publication_id FROM orders o LEFT JOIN intents i ON i.id=o.intent_id
         WHERE o.status='paid_awaiting_grant' ${op ? '' : 'AND o.buyer_org_id=?'} ORDER BY o.created_at`,
        ...(op ? [] : [u.org_id]));
      const quar = all(db,
        op ? 'SELECT q.*, o.buyer_org_id FROM grant_quarantine q JOIN orders o ON o.id=q.order_id ORDER BY q.created_at DESC'
          : 'SELECT q.* FROM grant_quarantine q JOIN orders o ON o.id=q.order_id WHERE o.buyer_org_id=? ORDER BY q.created_at DESC', u.org_id);
      const blocked = all(db, `SELECT * FROM publications WHERE status='blocked' ${op ? '' : 'AND buyer_org_id=?'}`, ...(op ? [] : [u.org_id]));
      html(res, 200, page(u, 'Inbox', `${notice(ctx)}
        <h1>Inbox</h1><p class="lede">Paid without a grant, quarantined grants and blocked releases.</p>
        <section class="card"><h2>Paid, awaiting grant (${awaiting.length})</h2>
          ${awaiting.length ? `<table><thead><tr><th>Order</th><th>Publication</th><th>Status</th></tr></thead><tbody>${awaiting.map((o: any) => `<tr><td><code>${esc(o.id)}</code></td><td><code>${esc(o.publication_id ?? '—')}</code></td><td>${pill(o.status)}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">Nothing pending.</p>'}
        </section>
        <section class="card"><h2>Quarantined grants (${quar.length})</h2>
          ${quar.length ? `<table><thead><tr><th>Order</th><th>Reason</th><th>When</th></tr></thead><tbody>${quar.map((q: any) => `<tr><td><code>${esc(q.order_id)}</code></td><td><code>${esc(q.reason)}</code></td><td>${esc(q.created_at)}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">Nothing quarantined.</p>'}
        </section>
        <section class="card"><h2>Blocked releases (${blocked.length})</h2>
          ${blocked.length ? `<table><thead><tr><th>Release</th><th>Intent</th></tr></thead><tbody>${blocked.map((p: any) => `<tr><td><a href="/console/releases/${esc(p.id)}"><code>${esc(p.id)}</code></a></td><td><a href="/console/cases/${esc(p.intent_id)}"><code>${esc(p.intent_id)}</code></a></td></tr>`).join('')}</tbody></table>` : '<p class="hint">Nothing blocked.</p>'}
        </section>`, 'inbox'));
      return true;
    }

    // ---- catalog ---------------------------------------------------------
    if (req.method === 'GET' && path === '/console/catalog') {
      const u = need(req, res); if (!u) return true;
      const assets = all<any>(db,
        `SELECT a.*, s.name AS seller_name, s.status AS seller_status,
          (SELECT json_group_array(json_object('revision', r.revision, 'hash', r.content_sha256))
            FROM asset_revisions r WHERE r.asset_id=a.id) AS revs,
          (SELECT json_group_array(json_object('id', o.id, 'price', o.price_atomic, 'expires', o.expires_at))
            FROM offers o WHERE o.asset_id=a.id) AS offs
         FROM assets a JOIN sellers s ON s.id=a.seller_id ORDER BY a.created_at`);
      html(res, 200, page(u, 'Catalog', `${notice(ctx)}
        <h1>Catalog</h1><p class="lede">Registered sellers, asset revisions and live offers.</p>
        ${assets.map(a => `<section class="card">
          <h2>${esc(a.title)} <span class="hint">· ${esc(a.seller_name)} ${pill(a.seller_status)}</span></h2>
          <table><thead><tr><th>Revision</th><th>Content hash</th><th>Offers</th></tr></thead><tbody>
          ${(JSON.parse(a.revs) as any[]).map(r => `<tr><td>r${r.revision}</td><td>${short(r.hash)}</td>
            <td>${(JSON.parse(a.offs) as any[]).map(o => `<code>${esc(o.id)}</code> ${o.price}μ exp ${esc(o.expires.slice(0, 10))}`).join('<br>') || '—'}</td></tr>`).join('')}
          </tbody></table></section>`).join('')}`, 'catalog'));
      return true;
    }

    // ---- case record -----------------------------------------------------
    if (req.method === 'GET' && path.startsWith('/console/cases/')) {
      const u = need(req, res); if (!u) return true;
      const i = intent(path.split('/')[3]!);
      if (!i || (u.role !== 'operator' && i.buyer_org_id !== u.org_id)) {
        html(res, 404, page(u, 'Case', '<p class="err">Case not found.</p>')); return true;
      }
      const offer = i.offer_id ? one<any>(db, 'SELECT * FROM offers WHERE id=?', i.offer_id) : null;
      const terms = offer ? JSON.parse(offer.terms_schema) : null;
      const grant = one<any>(db,
        `SELECT g.* FROM grants g JOIN orders o ON o.id=g.order_id WHERE o.intent_id=? ORDER BY g.created_at DESC`, i.id);
      const decisions = all<DecisionRow>(db, 'SELECT * FROM decisions WHERE intent_id=? ORDER BY evaluated_at DESC', i.id);
      const receipts = all<any>(db, 'SELECT * FROM publication_receipts WHERE intent_id=?', i.id);
      const reviews = all<any>(db, `SELECT * FROM reviews WHERE subject_kind='intent' AND subject_id=? ORDER BY version`, i.id);
      const decls = all<any>(db, 'SELECT * FROM control_declarations WHERE intent_id=?', i.id);
      const events = grant ? all<any>(db, 'SELECT * FROM grant_events WHERE grant_id=? ORDER BY seq', grant.id) : [];
      const pubs = all<PublicationRow>(db, 'SELECT * FROM publications WHERE intent_id=?', i.id);

      const row = (k: string, a: unknown, b: unknown, c: unknown) => {
        const eq = JSON.stringify(a) === JSON.stringify(c);
        return `<tr><td>${k}</td><td>${esc(typeof a === 'string' ? a : JSON.stringify(a))}</td>
          <td class="${b === null ? '' : eq ? 'hit' : 'miss'}">${esc(typeof b === 'string' ? b : JSON.stringify(b))}</td>
          <td class="${c === null ? 'miss' : eq ? 'hit' : 'miss'}">${esc(typeof c === 'string' ? c : JSON.stringify(c))}</td></tr>`;
      };
      const cmp = `<table class="cmp"><thead><tr><th>Dimension</th><th>Requested use</th><th>Offer scope</th><th>Grant scope</th></tr></thead><tbody>
        ${row('edition', i.edition, terms?.edition_set?.includes(i.edition) ? i.edition : terms?.edition_set, grant ? JSON.parse(grant.edition_set).includes(i.edition) ? i.edition : JSON.parse(grant.edition_set) : null)}
        ${row('channel', i.channel, terms?.channel_set?.includes(i.channel) ? i.channel : terms?.channel_set, grant ? JSON.parse(grant.channel_set).includes(i.channel) ? i.channel : JSON.parse(grant.channel_set) : null)}
        ${row('territory', JSON.parse(i.territory_set), terms?.territory_set, grant ? JSON.parse(grant.territory_set) : null)}
        ${row('purpose', i.purpose, terms?.purposes, grant ? JSON.parse(grant.purposes) : null)}
        ${row('attribution', i.attribution_text, terms?.attribution, grant?.attribution ?? null)}
        ${row('window', i.intended_at, `${terms?.valid_from} → ${terms?.valid_until}`, grant ? `${grant.valid_from} → ${grant.valid_until}` : null)}
        ${row('asset', i.asset_sha256, offer?.asset_sha256, grant?.asset_sha256 ?? null)}
      </tbody></table>`;

      const decHtml = decisions.map(d => {
        const dims = JSON.parse(d.dimensions) as { dimension: string; status: string; code: string; detail: string }[];
        return `<tr class="dec-head"><td colspan="2">Decision <code>${esc(d.id)}</code> ${pill(d.result)}
          <span class="hint">seq ${d.grant_seq ?? '—'} · ${esc(d.policy_version)} · ${esc(d.evaluated_at)}</span></td></tr>
          <tr><td colspan="2"><div>${dims.map(x => `<div class="dim"><b>${esc(x.dimension)}</b><span class="st ${esc(x.status)}">${esc(x.status)}</span><span>${esc(x.code)} — ${esc(x.detail)}</span></div>`).join('')}</div></td></tr>`;
      }).join('');

      const officer = u.role === 'rights_officer' || u.role === 'operator';
      const publisher = u.role === 'publisher' || u.role === 'operator';
      const editor = u.role === 'editor' || officer;

      html(res, 200, page(u, `Case ${i.publication_id}`, `${notice(ctx)}
        <h1>Case <code>${esc(i.publication_id)}</code> ${pill(i.status)}</h1>
        <p class="lede">Requested use beside the seller's offer scope and the issued grant — every decision dimension below.</p>
        <section class="card"><h2>Use vs scope</h2>${cmp}
          ${terms ? `<p class="hint">Terms digest <code>${esc(offer.terms_sha256.slice(0, 16))}…</code> · offer rev ${offer.revision} · ${esc(offer.terms_text)}</p>` : '<p class="warn-note">No offer selected yet.</p>'}
        </section>
        <section class="card"><h2>Grant ${grant ? pill(grant.status) : pill('none')}</h2>
          ${grant ? `<dl class="kv"><dt>Grant</dt><dd><code>${esc(grant.id)}</code> · key v${grant.issuer_key_version} · seq ${grant.status_seq}</dd>
            <dt>Credit line</dt><dd><b>${esc(grant.attribution)}</b></dd>
            <dt>Events</dt><dd>${events.map((e: any) => `${esc(e.seq)} ${esc(e.kind)}`).join(' → ')}</dd></dl>`
          : '<p class="warn-note">No seller-issued grant on file — payment alone creates no license.</p>'}
        </section>
        <div class="grid2">
        <section class="card"><h2>Decisions (${decisions.length})</h2>
          ${decisions.length ? `<table>${decHtml}</table>` : '<p class="hint">No evaluations yet.</p>'}
        </section>
        <section class="card"><h2>Receipts & releases</h2>
          ${receipts.length ? `<table><thead><tr><th>Receipt</th><th>Artifact</th><th>Decision</th><th>Published</th></tr></thead><tbody>
            ${receipts.map((r: any) => `<tr><td><code>${esc(r.id)}</code></td><td>${short(r.artifact_hash)}</td><td><code>${esc(r.decision_id)}</code></td><td>${esc(r.published_at)}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">No releases.</p>'}
          ${pubs.length ? `<p class="hint">Releases: ${pubs.map(p => `<a href="/console/releases/${esc(p.id)}"><code>${esc(p.id)}</code></a> ${pill(p.status)}`).join(' · ')}</p>` : ''}
        </section></div>
        <section class="card"><h2>Evidence</h2>
          ${decls.length ? `<p><b>Control declarations:</b></p><ul>${decls.map((d: any) => `<li><code>${esc(d.kind)}</code> — ${esc(d.reference)} ${short(d.digest)}</li>`).join('')}</ul>` : ''}
          ${i.control_evidence_ref ? `<p class="hint">Intent control evidence: ${esc(i.control_evidence_ref)} ${short(i.control_evidence_digest)}</p>` : ''}
          ${reviews.length ? `<p><b>Officer reviews:</b></p><ul>${reviews.map((r: any) => `<li>v${r.version} ${pill(r.verdict)} — ${esc(r.rationale)} <span class="hint">(scope: ${esc(r.evidence_scope)})</span></li>`).join('')}</ul>` : '<p class="hint">No reviews on file.</p>'}
        </section>
        <section class="card"><h2>Actions</h2>
          ${publisher ? `<form method="post" action="/console/cases/${esc(i.id)}/evaluate">
            <label for="ah">Artifact hash to evaluate</label>
            <input id="ah" name="artifact_hash" required pattern="[0-9a-f]{64}" placeholder="64-hex edition artifact digest">
            <p class="hint">Re-runs the deterministic evaluator for this exact artifact.</p>
            <button class="btn" type="submit">Evaluate</button></form>
          <form method="post" action="/console/cases/${esc(i.id)}/release">
            <label for="ah2">Register release artifact</label>
            <input id="ah2" name="artifact_hash" required pattern="[0-9a-f]{64}" placeholder="64-hex edition artifact digest">
            <button class="btn" type="submit">Register & confirm release</button></form>` : ''}
          ${officer ? `<form method="post" action="/console/cases/${esc(i.id)}/review"><fieldset>
            <label for="v">Verdict</label><select id="v" name="verdict"><option>accepted</option><option>rejected</option><option>noted</option></select>
            <label for="sc">Evidence scope (dimensions covered, comma-separated)</label>
            <input id="sc" name="evidence_scope" required placeholder="terms_support">
            <label for="ra">Rationale</label><textarea id="ra" name="rationale" required rows="2"></textarea>
            <button class="btn" type="submit">Record review</button></fieldset></form>` : ''}
          ${editor ? `<form method="post" action="/console/cases/${esc(i.id)}/controls">
            <label for="cr">Distribution-control reference</label>
            <input id="cr" name="reference" required placeholder="controls://edition-routing/in-only">
            <label for="cd">Evidence digest</label>
            <input id="cd" name="digest" required pattern="[0-9a-f]{64}" placeholder="64-hex">
            <button class="btn" type="submit">Declare controls</button></form>` : ''}
          <p class="hint">Copy-paste publication paths outside this release hook are not licensed by any decision shown here.</p>
        </section>`, ''));
      return true;
    }

    // ---- release record ---------------------------------------------------
    if (req.method === 'GET' && path.startsWith('/console/releases/')) {
      const u = need(req, res); if (!u) return true;
      const p = one<PublicationRow>(db, 'SELECT * FROM publications WHERE id=?', path.split('/')[3]!);
      if (!p || (u.role !== 'operator' && p.buyer_org_id !== u.org_id)) {
        html(res, 404, page(u, 'Release', '<p class="err">Release not found.</p>')); return true;
      }
      const receipts = all<any>(db, 'SELECT * FROM publication_receipts WHERE publication_id=?', p.id);
      const decs = all<any>(db, 'SELECT * FROM decisions WHERE intent_id=? AND artifact_hash=? ORDER BY evaluated_at DESC', p.intent_id, p.artifact_hash);
      html(res, 200, page(u, `Release ${p.id}`, `${notice(ctx)}
        <h1>Release <code>${esc(p.id)}</code> ${pill(p.status)}</h1>
        <p class="lede"><a href="/console/cases/${esc(p.intent_id)}">← back to case ${esc(p.intent_id)}</a></p>
        <section class="card"><dl class="kv">
          <dt>Artifact hash</dt><dd><code>${esc(p.artifact_hash)}</code></dd>
          <dt>Status</dt><dd>${pill(p.status)}</dd>
          <dt>Receipts</dt><dd>${receipts.map((r: any) => `<code>${esc(r.id)}</code> @ ${esc(r.published_at)}`).join('<br>') || '—'}</dd>
          <dt>Decisions</dt><dd>${decs.map((d: any) => `${pill(d.result)} <code>${esc(d.id)}</code>`).join('<br>') || '—'}</dd>
        </dl>
        ${(u.role === 'publisher' || u.role === 'operator') && p.status !== 'released' ? `
        <form method="post" action="/console/releases/${esc(p.id)}/confirm">
          <button class="btn" type="submit">Re-run release gate</button>
          <span class="hint">Re-evaluates the live grant state before publish.</span></form>` : ''}
        </section>`, ''));
      return true;
    }

    // ---- console form posts ----------------------------------------------
    if (req.method === 'POST' && path.startsWith('/console/cases/') && path.endsWith('/evaluate')) {
      const u = need(req, res); if (!u) return true;
      const i = intent(path.split('/')[3]!); if (!i) throw notFound2();
      if (!['publisher', 'rights_officer', 'operator'].includes(u.role)) {
        redirect(res, `/console/cases/${i.id}?error=${encodeURIComponent(`role ${u.role} cannot evaluate`)}`); return true;
      }
      const b = await body();
      const ah = (b.artifact_hash ?? '').trim();
      if (!/^[0-9a-f]{64}$/.test(ah)) { redirect(res, `/console/cases/${i.id}?error=${encodeURIComponent('artifact_hash must be 64 lowercase hex')}`); return true; }
      const assetHash = typeof b.artifact_asset_sha256 === 'string' && /^[0-9a-f]{64}$/.test(b.artifact_asset_sha256)
        ? b.artifact_asset_sha256 : null;
      const ev = evaluate(db, i, ah, assetHash, now());
      persistDecision(db, i, ah, ev, u.id);
      redirect(res, `/console/cases/${i.id}?notice=${encodeURIComponent(`Decision recorded: ${ev.result}`)}`);
      return true;
    }

    if (req.method === 'POST' && path.startsWith('/console/cases/') && path.endsWith('/review')) {
      const u = need(req, res); if (!u) return true;
      const i = intent(path.split('/')[3]!); if (!i) throw notFound2();
      if (u.role !== 'rights_officer' && u.role !== 'operator') {
        redirect(res, `/console/cases/${i.id}?error=${encodeURIComponent(`role ${u.role} cannot record reviews`)}`); return true;
      }
      const b = await body();
      if (!b.verdict || !b.rationale || !b.evidence_scope) {
        redirect(res, `/console/cases/${i.id}?error=${encodeURIComponent('verdict, scope and rationale are required')}`); return true;
      }
      const version = (one<{ m: number }>(db,
        `SELECT COALESCE(MAX(version),0)+1 AS m FROM reviews WHERE subject_kind='intent' AND subject_id=?`, i.id))!.m;
      db.prepare(`INSERT INTO reviews (id, subject_kind, subject_id, version, reviewer_id, verdict, rationale, evidence_scope, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(rid('rev'), 'intent', i.id, version, u.id, b.verdict, b.rationale, b.evidence_scope, now());
      db.prepare(`UPDATE intents SET status='specified' WHERE id=? AND status='rights_review'`).run(i.id);
      audit(db, u.id, 'review.recorded', { subjectKind: 'intent', subjectId: i.id });
      redirect(res, `/console/cases/${i.id}?notice=${encodeURIComponent(`Review v${version} recorded (${b.verdict})`)}`);
      return true;
    }

    if (req.method === 'POST' && path.startsWith('/console/cases/') && path.endsWith('/controls')) {
      const u = need(req, res); if (!u) return true;
      const i = intent(path.split('/')[3]!); if (!i) throw notFound2();
      if (!['editor', 'rights_officer', 'operator'].includes(u.role)) {
        redirect(res, `/console/cases/${i.id}?error=${encodeURIComponent(`role ${u.role} cannot declare controls`)}`); return true;
      }
      const b = await body();
      if (!b.reference || !/^[0-9a-f]{64}$/.test(b.digest ?? '')) {
        redirect(res, `/console/cases/${i.id}?error=${encodeURIComponent('reference and a 64-hex digest are required')}`); return true;
      }
      db.prepare(`INSERT INTO control_declarations (id, intent_id, declared_by, kind, reference, digest, created_at)
        VALUES (?,?,?,?,?,?,?)`)
        .run(rid('dec_ctl'), i.id, u.id, 'distribution_controls', b.reference, b.digest, now());
      audit(db, u.id, 'controls.declared', { subjectKind: 'intent', subjectId: i.id });
      redirect(res, `/console/cases/${i.id}?notice=${encodeURIComponent('Control declaration recorded')}`);
      return true;
    }

    if (req.method === 'POST' && path.startsWith('/console/cases/') && path.endsWith('/release')) {
      const u = need(req, res); if (!u) return true;
      const i = intent(path.split('/')[3]!); if (!i) throw notFound2();
      if (u.role !== 'publisher' && u.role !== 'operator') {
        redirect(res, `/console/cases/${i.id}?error=${encodeURIComponent(`role ${u.role} cannot release`)}`); return true;
      }
      const b = await body();
      const ah = (b.artifact_hash ?? '').trim();
      if (!/^[0-9a-f]{64}$/.test(ah)) {
        redirect(res, `/console/cases/${i.id}?error=${encodeURIComponent('artifact_hash must be 64 lowercase hex')}`); return true;
      }
      const pid = rid('pub');
      db.prepare(`INSERT INTO publications (id, buyer_org_id, intent_id, artifact_hash, status, created_at)
        VALUES (?,?,?,?, 'draft', ?)`).run(pid, i.buyer_org_id, i.id, ah, now());
      const pub = one<PublicationRow>(db, 'SELECT * FROM publications WHERE id=?', pid)!;
      const out = confirmPublication(db, pub, i, ah, null, u.id);
      const msg = out.status === 'released'
        ? `Released — receipt ${out.receipt.id}${out.replayed ? ' (replayed)' : ''}`
        : `Blocked — ${out.evaluation.reason_codes.join(', ')}`;
      redirect(res, `/console/releases/${pid}?${out.status === 'released' ? 'notice' : 'error'}=${encodeURIComponent(msg)}`);
      return true;
    }

    if (req.method === 'POST' && path.startsWith('/console/releases/') && path.endsWith('/confirm')) {
      const u = need(req, res); if (!u) return true;
      const p = one<PublicationRow>(db, 'SELECT * FROM publications WHERE id=?', path.split('/')[3]!);
      if (u.role !== 'publisher' && u.role !== 'operator') {
        redirect(res, `/console/releases/${p ? p.id : ''}?error=${encodeURIComponent(`role ${u.role} cannot release`)}`); return true;
      }
      if (!p) throw notFound2();
      const i = intent(p.intent_id)!;
      const out = confirmPublication(db, p, i, p.artifact_hash, p.artifact_asset_sha256, u.id);
      const msg = out.status === 'released'
        ? `Released — receipt ${out.receipt.id}${out.replayed ? ' (replayed)' : ''}`
        : `Blocked — ${out.evaluation.reason_codes.join(', ')}`;
      redirect(res, `/console/releases/${p.id}?${out.status === 'released' ? 'notice' : 'error'}=${encodeURIComponent(msg)}`);
      return true;
    }

    return false;
  };
}

const notFound2 = () => new ApiError(404, 'not_found', 'record not found');
