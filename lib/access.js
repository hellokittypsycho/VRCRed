import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import { openDatabase } from './database.js';

const scrypt = promisify(scryptCallback), lifetime = 30 * 86400000, cookieName = 'deck_session';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const digest = value => createHash('sha256').update(value).digest('hex');
const userView = row => ({ id: row.id, username: row.username, role: row.role, disabled: !!row.disabled, createdAt: row.created_at, lastLogin: row.last_login });
export function publicOrigin(value = '') {
  if (!value) return '';
  let url;
  try { url = new URL(value); } catch { throw fail('Enter the public HTTPS URL of your panel, without a path.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw fail('Use only the HTTPS origin, without a path.');
  return url.origin;
}
function username(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_-]{2,23}$/.test(value)) throw fail('Use 3–24 letters, numbers, underscores or hyphens for your username.');
  return value;
}
async function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw fail('Use a password between 12 and 256 characters.');
  const salt = randomBytes(24).toString('hex'), cost = 32768;
  return { salt, cost, hash: (await scrypt(password, salt, 64, { N: cost, maxmem: 64 * 1024 * 1024 })).toString('hex') };
}
async function matches(password, record) {
  if (typeof password !== 'string' || password.length > 256) return false;
  const actual = await scrypt(password, record.salt, 64, { N: record.cost || 16384, maxmem: 64 * 1024 * 1024 });
  const expected = Buffer.from(record.hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export async function createAccess(file, { legacyFile } = {}) {
  const db = await openDatabase(file, legacyFile), live = new Map();
  let setupPending = false, onRevoke = () => {};
  const selectUser = db.prepare('SELECT * FROM users WHERE id=?');
  const sessionRow = db.prepare('SELECT s.*,u.username,u.role,u.disabled FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?');
  const configured = () => !!db.prepare('SELECT id FROM users LIMIT 1').get();
  function endResources(session) {
    if (session.revoked) return;
    session.revoked = true; live.delete(session.id);
    onRevoke(session);
    for (const res of session.resources) res.end(); session.resources.clear(); live.delete(session.id);
  }
  function revoke(session) { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(session.id); endResources(session); }
  function invalidateUser(id) {
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
    for (const session of [...live.values()]) if (session.userId === id) endResources(session);
  }
  function valid(session) {
    if (session.revoked) return false;
    const row = sessionRow.get(session.id);
    if (!row || row.disabled || row.expires_at <= Date.now()) { revoke(session); return false; }
    session.role = row.role; session.username = row.username; return true;
  }
  function authenticate(req) {
    const token = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const id = digest(token), row = sessionRow.get(id);
    if (!row || row.disabled || row.expires_at <= Date.now()) {
      if (live.has(id)) revoke(live.get(id)); else if (row) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(id);
      return null;
    }
    let session = live.get(id);
    if (!session) {
      session = { id, userId: row.user_id, role: row.role, username: row.username, csrf: row.csrf, expires: row.expires_at, resources: new Set(), commands: [] };
      live.set(id, session);
    }
    session.role = row.role; session.username = row.username;
    return session;
  }
  function issue(res, user, secure) {
    db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
    if (db.prepare('SELECT count(*) AS count FROM sessions').get().count >= 128) throw fail('Too many active sign-ins. Sign out an old session first.', 429);
    const token = randomBytes(32).toString('hex'), id = digest(token), csrf = randomBytes(24).toString('hex'), expires = Date.now() + lifetime;
    db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)').run(id, user.id, csrf, expires);
    db.prepare('UPDATE users SET last_login=? WHERE id=?').run(Date.now(), user.id);
    const session = { id, userId: user.id, role: user.role, username: user.username, csrf, expires, resources: new Set(), commands: [] };
    live.set(id, session);
    res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${lifetime / 1000}${secure ? '; Secure' : ''}`);
    return session;
  }
  function throttle(req, secure) {
    const forwarded = req.headers['x-forwarded-for']?.split(',').at(-1)?.trim();
    const client = secure && isIP(forwarded || '') ? forwarded : req.socket.remoteAddress || 'local';
    const now = Date.now();
    for (const [key, limit] of [[`client:${client}`,20],['global',100]]) {
      const old = db.prepare('SELECT * FROM auth_limits WHERE key=?').get(key);
      if (old && now - old.started_at < 600000 && old.attempts >= limit) throw fail('Too many sign-in attempts. Try again in 10 minutes.', 429);
    }
    for (const key of [`client:${client}`, 'global']) db.prepare(`INSERT INTO auth_limits(key,started_at,attempts) VALUES(?,?,1)
      ON CONFLICT(key) DO UPDATE SET started_at=CASE WHEN ?-started_at>=600000 THEN ? ELSE started_at END,
      attempts=CASE WHEN ?-started_at>=600000 THEN 1 ELSE attempts+1 END`).run(key,now,now,now,now);
    db.prepare('DELETE FROM auth_limits WHERE started_at<?').run(now - 86400000);
  }
  function requireAdmin(session) { if (!valid(session) || session.role !== 'admin') throw fail('Only admins can send commands or change settings.', 403); }
  function listInvites() {
    return db.prepare('SELECT id,label,max_uses AS maxUses,uses,expires_at AS expiresAt,revoked,created_at AS createdAt FROM invites ORDER BY id DESC LIMIT 100').all();
  }
  const api = {
    db, authenticate, valid, requireAdmin,
    get configured() { return configured(); },
    get origin() { return db.prepare("SELECT value FROM settings WHERE key='publicOrigin'").get()?.value || ''; },
    get migrated() { return db.prepare("SELECT value FROM settings WHERE key='legacyMigrated'").get()?.value === 'true'; },
    set onRevoke(callback) { onRevoke = callback; },
    attach(session, res) {
      session.resources.add(res);
      let timer;
      const expire = () => {
        const remaining = session.expires - Date.now();
        if (remaining <= 0) { revoke(session); return; }
        timer = setTimeout(expire, Math.min(remaining, 2147483647)); timer.unref();
      };
      expire();
      res.on('close', () => { clearTimeout(timer); session.resources.delete(res); });
    },
    rateCommand(session) {
      const now = Date.now(); session.commands = session.commands.filter(t => t > now - 1000);
      if (session.commands.length >= 80) throw fail('Slow down for a moment.', 429);
      session.commands.push(now);
    },
    async setup(body, res, secure) {
      if (configured() || setupPending) throw fail('The first admin account has already been created.', 409);
      setupPending = true;
      try {
        const name = username(body.username), origin = publicOrigin(body.publicOrigin);
        const password = await passwordHash(body.password);
        const result = db.prepare("INSERT INTO users(username,salt,hash,cost,role,created_at) VALUES(?,?,?,?,'admin',?)").run(name,password.salt,password.hash,password.cost,Date.now());
        db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('publicOrigin',?)").run(origin);
        return issue(res, selectUser.get(Number(result.lastInsertRowid)), secure);
      } finally { setupPending = false; }
    },
    async login(body, req, res, secure) {
      if (!configured()) throw fail('The first admin must set up an account on this PC.', 409);
      throttle(req, secure);
      const name = typeof body.username === 'string' ? body.username.slice(0, 100) : '';
      const row = db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').get(name);
      const dummy = { salt: '0'.repeat(48), hash: '0'.repeat(128), cost: 32768 };
      const correct = await matches(body.password, row || dummy);
      const current = row && selectUser.get(row.id);
      if (!correct || !current || current.disabled || current.version !== row.version) throw fail('Username or password did not match.', 401);
      return issue(res, current, secure);
    },
    async register(body, req, res, secure) {
      if (!configured()) throw fail('The first admin must set up an account first.', 409);
      throttle(req, secure);
      const name = username(body.username);
      if (typeof body.invite !== 'string' || body.invite.length > 256 || !body.invite.trim()) throw fail('Enter the invitation code from your admin.');
      const code = body.invite.trim(), now = Date.now();
      let invite = db.prepare('SELECT * FROM invites WHERE code_hash=?').get(digest(code));
      if (!invite) {
        const legacy = db.prepare('SELECT * FROM invites WHERE legacy_hash IS NOT NULL AND revoked=0 AND uses<max_uses AND expires_at>?').get(now);
        if (legacy && await matches(code, { salt: legacy.legacy_salt, hash: legacy.legacy_hash, cost: 16384 })) invite = legacy;
      }
      if (!invite || invite.revoked || invite.uses >= invite.max_uses || invite.expires_at <= now) throw fail('That invitation is invalid, expired or already used.', 403);
      if (db.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(name)) throw fail('That username is already in use.', 409);
      const password = await passwordHash(body.password);
      let id;
      db.exec('BEGIN IMMEDIATE');
      try {
        const updated = db.prepare('UPDATE invites SET uses=uses+1 WHERE id=? AND revoked=0 AND uses<max_uses AND expires_at>?').run(invite.id, Date.now());
        if (!updated.changes) throw fail('That invitation is no longer available.', 403);
        const result = db.prepare("INSERT INTO users(username,salt,hash,cost,role,created_at) VALUES(?,?,?,?,'viewer',?)").run(name,password.salt,password.hash,password.cost,Date.now());
        id = Number(result.lastInsertRowid); db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        if (String(error.message).includes('UNIQUE constraint')) throw fail('That username is already in use.', 409);
        throw error;
      }
      return issue(res, selectUser.get(id), secure);
    },
    logout(session, res) {
      revoke(session);
      res.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    },
    async changePassword(body, session, res, secure) {
      const user = selectUser.get(session.userId);
      if (!await matches(body.currentPassword, user)) throw fail('Your current password did not match.');
      const password = await passwordHash(body.newPassword);
      if (!db.prepare('UPDATE users SET salt=?,hash=?,cost=?,version=version+1 WHERE id=? AND version=? AND disabled=0').run(password.salt,password.hash,password.cost,user.id,user.version).changes) throw fail('Your account changed. Sign in again.', 409);
      invalidateUser(user.id); return issue(res, selectUser.get(user.id), secure);
    },
    // Used only by the separately launched, loopback-only recovery utility.
    // The panel's HTTP API never exposes this operation.
    async resetAdminLocally(name, newPassword, res) {
      const user = db.prepare("SELECT * FROM users WHERE username=? COLLATE NOCASE AND role='admin' AND disabled=0").get(name);
      if (!user) throw fail('An active admin account with that username was not found.', 404);
      const password = await passwordHash(newPassword);
      db.exec('BEGIN IMMEDIATE');
      try {
        const updated = db.prepare("UPDATE users SET salt=?,hash=?,cost=?,version=version+1 WHERE id=? AND version=? AND role='admin' AND disabled=0")
          .run(password.salt, password.hash, password.cost, user.id, user.version);
        if (!updated.changes) throw fail('The admin account changed. Start recovery again.', 409);
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      invalidateUser(user.id);
      return issue(res, selectUser.get(user.id), false);
    },
    users(session) { requireAdmin(session); return db.prepare('SELECT * FROM users ORDER BY username COLLATE NOCASE').all().map(userView); },
    updateUser(body, session) {
      requireAdmin(session);
      if (!Number.isSafeInteger(body.id) || !['admin','viewer'].includes(body.role) || typeof body.disabled !== 'boolean') throw fail('Invalid account update.');
      if (body.id === session.userId) throw fail('Use another admin account to change your own permissions.');
      const user = selectUser.get(body.id); if (!user) throw fail('Account not found.',404);
      if (user.role === 'admin' && !user.disabled && (body.role !== 'admin' || body.disabled) && db.prepare("SELECT count(*) AS count FROM users WHERE role='admin' AND disabled=0").get().count <= 1) throw fail('Keep at least one active admin account.');
      db.prepare('UPDATE users SET role=?,disabled=?,version=version+1 WHERE id=?').run(body.role,Number(body.disabled),body.id);
      invalidateUser(body.id);
    },
    invites(session) { requireAdmin(session); return listInvites(); },
    createInvite(body, session) {
      requireAdmin(session);
      const maxUses = body.maxUses ?? 1, days = body.days ?? 7;
      if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100 || ![1,7,30].includes(days)) throw fail('Choose 1–100 uses and an expiry of 1, 7 or 30 days.');
      const code = randomBytes(18).toString('base64url'), now = Date.now();
      const label = typeof body.label === 'string' ? body.label.trim().slice(0,60) : 'Friends invite';
      db.prepare('INSERT INTO invites(code_hash,label,max_uses,expires_at,created_at) VALUES(?,?,?,?,?)').run(digest(code),label || 'Friends invite',maxUses,now + days*86400000,now);
      return { code, invites: listInvites() };
    },
    revokeInvite(body, session) {
      requireAdmin(session);
      if (!Number.isSafeInteger(body.id)) throw fail('Invalid invitation.');
      db.prepare('UPDATE invites SET revoked=1 WHERE id=?').run(body.id);
    },
    updateOrigin(value) { db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('publicOrigin',?)").run(publicOrigin(value)); },
    close() { onRevoke = () => {}; for (const session of [...live.values()]) endResources(session); db.close(); },
  };
  return api;
}
