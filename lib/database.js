import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export async function openDatabase(file, legacyFile) {
  if (file !== ':memory:') await mkdir(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS users(
      id INTEGER PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      salt TEXT NOT NULL, hash TEXT NOT NULL, cost INTEGER NOT NULL DEFAULT 32768,
      role TEXT NOT NULL CHECK(role IN ('admin','viewer')), disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)),
      version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, last_login INTEGER
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sessions(
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS invites(
      id INTEGER PRIMARY KEY, code_hash TEXT UNIQUE, legacy_salt TEXT, legacy_hash TEXT,
      label TEXT NOT NULL, max_uses INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS auth_limits(key TEXT PRIMARY KEY, started_at INTEGER NOT NULL, attempts INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS chat_messages(
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
      text TEXT NOT NULL, created_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE INDEX IF NOT EXISTS chat_user_time ON chat_messages(user_id, created_at);
    PRAGMA user_version=1;`);
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  if (legacyFile && !db.prepare('SELECT id FROM users LIMIT 1').get()) {
    let old;
    try { old = JSON.parse((await readFile(legacyFile, 'utf8')).replace(/^\uFEFF/, '')); }
    catch (error) { if (error.code !== 'ENOENT') { db.close(); throw new Error('Cannot migrate the existing password file. The original file has been preserved.'); } }
    if (old) {
      const valid = r => r && /^[a-f0-9]{48}$/.test(r.salt) && /^[a-f0-9]{128}$/.test(r.hash);
      if (!valid(old.host) || !valid(old.friend)) { db.close(); throw new Error('Existing password file is invalid; it has been preserved.'); }
      const now = Date.now();
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare("INSERT INTO users(username,salt,hash,cost,role,created_at) VALUES('admin',?,?,16384,'admin',?)").run(old.host.salt, old.host.hash, now);
        db.prepare("INSERT INTO invites(legacy_salt,legacy_hash,label,max_uses,expires_at,created_at) VALUES(?,?,'Previous friends password',25,?,?)").run(old.friend.salt, old.friend.hash, now + 7 * 86400000, now);
        db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('publicOrigin',?)").run(String(old.publicOrigin || ''));
        db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('legacyMigrated','true')").run();
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
    }
  }
  return db;
}
