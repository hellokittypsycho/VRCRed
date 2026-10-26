import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { createAdminResetServer } from '../scripts/reset-admin.js';

async function fixture(t, username = 'admin') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deck-recovery-'));
  const databaseFile = path.join(directory, 'deck.sqlite');
  const app = await createApp({ port: 0, receivePort: 0, oscQuery: false, avatarRoot: path.join(directory, 'none'), databaseFile });
  const post = (route, body, headers = {}) => fetch(`${app.url}/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const session = async response => {
    assert.equal(response.status, 200); const body = await response.json();
    return { Cookie: response.headers.get('set-cookie').split(';')[0], 'X-Deck-Token': body.token };
  };
  const admin = await session(await post('auth/setup', { username, password: 'old-admin-password-123' }));
  const code = (await (await post('invites/create', {}, admin)).json()).code;
  const viewer = await session(await post('auth/register', { username: 'Viewer', password: 'viewer-password-123', invite: code }));
  await post('chat/send', { text: 'Keep our chat history.' }, viewer);
  t.after(async () => { await app.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); await rm(directory, { recursive: true, force: true }); });
  return { app, post, admin, viewer, databaseFile };
}

test('local recovery resets only the target admin, signs in automatically and keeps accounts and chat', async t => {
  const f = await fixture(t);
  const recovery = await createAdminResetServer({ databaseFile: f.databaseFile, panelUrl: f.app.url, port: 0 });
  t.after(() => recovery.close());
  const page = await fetch(recovery.url);
  assert.equal(page.headers.get('referrer-policy'), 'same-origin', 'native form submissions must retain their origin');
  const html = await page.text();
  const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)[1];
  const reset = (password, confirm = password, extra = {}, nonce = csrf) => fetch(`${recovery.url}reset`, {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: new URL(recovery.url).origin, ...extra },
    body: new URLSearchParams({ csrf: nonce, password, confirm }),
  });
  assert.equal((await fetch(recovery.url, { headers: { 'X-Forwarded-For': '1.2.3.4' } })).status, 403);
  assert.equal((await reset('replacement-password-123', undefined, { 'X-Forwarded-Proto': 'https' })).status, 403);
  assert.equal((await reset('replacement-password-123', undefined, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await reset('replacement-password-123', undefined, { Origin: 'null' })).status, 403, 'opaque origins remain blocked');
  assert.equal((await reset('replacement-password-123', undefined, {}, 'bad')).status, 403);
  assert.equal((await reset('replacement-password-123', 'different-password')).status, 400);
  assert.equal((await reset('short')).status, 400);
  const result = await reset('replacement-password-123');
  assert.equal(result.status, 303); assert.equal(result.headers.get('location'), f.app.url + '/');
  assert.match(result.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.deepEqual(await recovery.done, { reset: true });
  const cookie = result.headers.get('set-cookie').split(';')[0];
  const signedIn = await (await fetch(`${f.app.url}/api/auth/session`, { headers: { Cookie: cookie } })).json();
  assert.equal(signedIn.authenticated, true); assert.equal(signedIn.user.role, 'admin'); assert.equal(signedIn.user.username, 'admin');
  assert.equal((await fetch(`${f.app.url}/api/state`, { headers: f.admin })).status, 401, 'old admin sessions are revoked');
  assert.equal((await fetch(`${f.app.url}/api/state`, { headers: f.viewer })).status, 200, 'other accounts stay signed in');
  const history = await (await fetch(`${f.app.url}/api/chat`, { headers: f.viewer })).json();
  assert.equal(history.messages[0].text, 'Keep our chat history.');
  assert.equal((await f.post('auth/login', { username: 'admin', password: 'old-admin-password-123' })).status, 401);
  assert.equal((await f.post('auth/login', { username: 'admin', password: 'replacement-password-123' })).status, 200);
  await assert.rejects(fetch(recovery.url), 'recovery listener closes after use');
});

test('recovery expires without changing the password and rejects non-admin targets', async t => {
  const f = await fixture(t);
  await assert.rejects(createAdminResetServer({ databaseFile: f.databaseFile, username: 'Viewer', port: 0 }), /Active admin account not found/);
  const recovery = await createAdminResetServer({ databaseFile: f.databaseFile, panelUrl: f.app.url, port: 0, ttlMs: 30 });
  assert.deepEqual(await recovery.done, { reset: false });
  assert.equal((await f.post('auth/login', { username: 'admin', password: 'old-admin-password-123' })).status, 200);
});

test('recovery automatically selects the sole admin when their username is customized', async t => {
  const f = await fixture(t, 'StreamHost');
  const recovery = await createAdminResetServer({ databaseFile: f.databaseFile, panelUrl: f.app.url, port: 0 });
  t.after(() => recovery.close());
  assert.equal(recovery.username, 'StreamHost');
  assert.match(await (await fetch(recovery.url)).text(), /StreamHost/);
  await recovery.close();
  assert.equal((await f.post('auth/login', { username: 'StreamHost', password: 'old-admin-password-123' })).status, 200);
});
