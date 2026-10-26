const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export class ChatRoom {
  constructor(db) {
    this.db = db;
    this.select = `SELECT m.id,m.user_id AS userId,u.username,u.role,m.text,m.created_at AS time,m.deleted
      FROM chat_messages m JOIN users u ON u.id=m.user_id`;
  }
  history(before) {
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw fail('Invalid message cursor.');
    return (before ? this.db.prepare(`${this.select} WHERE m.id<? ORDER BY m.id DESC LIMIT 100`).all(before)
      : this.db.prepare(`${this.select} ORDER BY m.id DESC LIMIT 100`).all()).reverse();
  }
  post(body, session) {
    if (typeof body.text !== 'string') throw fail('Write a message first.');
    const text = body.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim();
    if (!text || text.length > 500) throw fail('Messages must be between 1 and 500 characters.');
    const now = Date.now();
    const recent = this.db.prepare('SELECT count(*) AS count FROM chat_messages WHERE user_id=? AND created_at>?').get(session.userId, now-10000).count;
    if (recent >= 5) throw fail('Give chat a moment — up to 5 messages every 10 seconds.',429);
    const result = this.db.prepare('INSERT INTO chat_messages(user_id,text,created_at) VALUES(?,?,?)').run(session.userId,text,now);
    const id = Number(result.lastInsertRowid);
    // Retain a bounded history across streams without collecting an unlimited archive.
    this.db.prepare('DELETE FROM chat_messages WHERE id <= ?').run(id - 1000);
    return this.db.prepare(`${this.select} WHERE m.id=?`).get(id);
  }
  remove(body) {
    if (!Number.isSafeInteger(body.id) || body.id < 1) throw fail('Invalid message.');
    const result = this.db.prepare("UPDATE chat_messages SET deleted=1,text='' WHERE id=?").run(body.id);
    if (!result.changes) throw fail('Message not found.',404);
    return this.db.prepare(`${this.select} WHERE m.id=?`).get(body.id);
  }
}
