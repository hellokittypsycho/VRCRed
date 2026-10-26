import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { access as fileAccess } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createAccess } from '../lib/access.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export async function createAdminResetServer(options = {}) {
  const file = options.databaseFile ?? path.join(root, 'data', 'chaos-deck.sqlite');
  try { await fileAccess(file); } // Recovery must never create a replacement database.
  catch { throw new Error('No saved installation found. Start Chaos Deck and create your first admin account instead.'); }
  const store = await createAccess(file);
  const admins = store.db.prepare("SELECT username FROM users WHERE role='admin' AND disabled=0 ORDER BY id").all();
  const chosen = options.username ?? (admins.length === 1 ? admins[0].username : 'admin');
  const target = admins.find(admin => admin.username.toLowerCase() === chosen.toLowerCase());
  if (!target) { store.close(); throw new Error('Active admin account not found. Pass its username to this script.'); }
  const panel = new URL(options.panelUrl ?? `http://127.0.0.1:${process.env.PORT || 3210}/`);
  if (panel.protocol !== 'http:' || panel.hostname !== '127.0.0.1' || panel.username || panel.password) { store.close(); throw new Error('Recovery must return to the local panel.'); }
  const csrf = randomBytes(32).toString('hex');
  const expires = Date.now() + (options.ttlMs ?? 10 * 60000);
  let busy = false, used = false, closed = false, timer;
  let complete;
  const done = new Promise(resolve => { complete = resolve; });
  const server = http.createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    res.setHeader('Cache-Control', 'no-store');
    // Native form POSTs send Origin: null under no-referrer. Keep the real
    // same-origin header without sending referrers to other origins.
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${panel.origin}; frame-ancestors 'none'; base-uri 'none'`);
    function form(message = '', status = 200) {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#101010"><title>Reset admin password · Chaos Deck</title><style>
      :root{color-scheme:dark;font-family:Inter,'Segoe UI',Arial,sans-serif;background:#0b0c10;color:#f4f4f6;-webkit-font-smoothing:antialiased}*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:32px 16px;background:radial-gradient(ellipse at 50% -15%,#39202b77,transparent 55%),#0b0c10}.card{width:min(430px,100%);padding:32px;background:#14161c;border:1px solid #ffffff12;border-radius:16px;box-shadow:0 28px 90px #0004}.brand{font-weight:900;letter-spacing:-1.4px;font-size:25px;line-height:1;margin-bottom:35px}.brand span{color:#ed243b}.eyebrow{font-size:9px;font-weight:600;letter-spacing:1.8px;color:#8f96a6;margin-bottom:11px}h1{font-size:29px;font-weight:550;letter-spacing:-1px;line-height:1.2;margin:0 0 14px}p{margin:0;font-size:12px;color:#919aab;line-height:1.8}label{display:block;font-size:11px;color:#a4afc1;margin:22px 0 8px}input{width:100%;background:#0f1014;color:#eee;border:1px solid #ffffff24;border-radius:8px;padding:12px 13px;font:inherit;font-size:14px;line-height:1.5}input:focus{border-color:#818ea766;box-shadow:0 0 0 3px #818ea70b}input:focus-visible,button:focus-visible{outline:2px solid #ff788a;outline-offset:3px}button{width:100%;min-height:44px;margin-top:25px;padding:12px;background:#ed243b;color:white;border:0;border-radius:8px;font:inherit;font-size:12px;font-weight:600;cursor:pointer}button:hover{background:#fb3850}.note{font-size:10px;color:#737f94;margin-top:19px}.error{color:#f398a8;font-size:12px}.error:not(:empty){margin-top:15px}strong{color:#c7cad2;font-weight:550}@media(max-width:500px){.card{padding:27px}input{font-size:16px}}
      </style></head><body><main class="card"><div class="brand"><span>CHAOS</span>DECK</div><p class="eyebrow">LOCAL ACCOUNT RECOVERY</p><h1>Choose a new password.</h1><p>Reset the password for <strong>${escape(target.username)}</strong>. Your accounts, chat and stream settings will stay saved.</p><form method="post" action="/reset"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="username" value="${escape(target.username)}" autocomplete="username"><label for="password">New password</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="12" maxlength="256" required autofocus><label for="confirm">Confirm new password</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="12" maxlength="256" required><p class="error" role="alert">${escape(message)}</p><button type="submit">Reset password &amp; sign in</button></form><p class="note">Use at least 12 characters. This recovery page works only on this PC and expires after 10 minutes. Previous sign-ins for this admin will be signed out.</p></main></body></html>`);
    }
    try {
      if (req.headers.host !== `127.0.0.1:${server.address().port}` || req.socket.remoteAddress !== '127.0.0.1' || Object.keys(req.headers).some(key => key === 'forwarded' || key.startsWith('x-forwarded-'))) throw fail('Direct access from the host PC is required.', 403);
      if (req.headers.origin && req.headers.origin !== origin) throw fail('Same-origin requests required.', 403);
      if (used || closed || Date.now() >= expires) throw fail('This recovery page has expired. Start the recovery utility again.', 410);
      if (req.method === 'GET' && req.url === '/') { form(); return; }
      if (req.method !== 'POST' || req.url !== '/reset') throw fail('Not found.', 404);
      if (req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') throw fail('Submit the form from this recovery page.', 403);
      if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) throw fail('Submit the password form.', 415);
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 4096) throw fail('Request too large.', 413); }
      const body = new URLSearchParams(raw);
      if (body.get('csrf') !== csrf) throw fail('Refresh the recovery page and try again.', 403);
      const password = body.get('password');
      if (password !== body.get('confirm')) throw fail('The passwords do not match.');
      if (busy) throw fail('A reset is already in progress.', 409);
      busy = true;
      try {
        await store.resetAdminLocally(target.username, password, res);
        used = true;
        res.once('finish', () => { void close(); });
        res.writeHead(303, { Location: panel.href }); res.end();
      } finally { busy = false; }
    } catch (error) {
      if (!res.headersSent) form(error.status ? error.message : 'The password could not be reset. Start recovery again.', error.status || 500);
      else res.end();
    }
  });
  async function close() {
    if (closed) return; closed = true; clearTimeout(timer);
    await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); server.closeAllConnections(); });
    store.close(); complete({ reset: used });
  }
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 3212, '127.0.0.1', resolve); }); }
  catch (error) { store.close(); throw error; }
  timer = setTimeout(() => { void close(); }, Math.max(1, expires - Date.now())); timer.unref();
  return { url: `http://127.0.0.1:${server.address().port}/`, username: target.username, close, done };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const reset = await createAdminResetServer({ username: process.argv[2] });
    console.log(`\n  CHAOS DECK · LOCAL PASSWORD RECOVERY\n  Account: ${reset.username}\n  Open ${reset.url}\n  Choose your new password in that form. This page expires in 10 minutes.\n`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void reset.close(); });
    const result = await reset.done;
    console.log(result.reset ? 'Admin password reset successfully.' : 'Recovery closed. The password was not changed.');
  } catch (error) { console.error(`Recovery could not start: ${error.message}`); process.exitCode = 1; }
}
