const heading = 'STREAM CHAT';
const interval = 3000, maxAge = 30000, maxMessages = 3;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function shorten(text, budget) {
  if (text.length <= budget) return text;
  let short = '';
  for (const { segment } of graphemes.segment(text)) {
    if (short.length + segment.length > budget - 1) break;
    short += segment;
  }
  return `${short}…`;
}

export function chatboxText(messages) {
  const recent = messages.slice(-maxMessages);
  if (!recent.length) return '';
  const names = recent.map(message => `${message.username} › `);
  const bodies = recent.map(message => message.text.replace(/\s+/gu, ' ').trim());
  // Share the box fairly; short lines donate spare space to longer ones.
  let available = 144 - heading.length - recent.length - names.reduce((sum, name) => sum + name.length, 0);
  const budgets = bodies.map(() => 0);
  while (available > 0) {
    let allocated = false;
    for (let index = bodies.length - 1; index >= 0 && available > 0; index--) {
      if (budgets[index] >= bodies[index].length) continue;
      budgets[index]++; available--; allocated = true;
    }
    if (!allocated) break;
  }
  return [heading, ...names.map((name, index) => name + shorten(bodies[index], budgets[index]))].join('\n');
}

// VRChat replaces its whole chatbox on every update, so send a complete recent feed.
// This buffer starts empty: old website history is never replayed on enable/restart.
export class ChatRelay {
  constructor(send, { now = Date.now, schedule = setTimeout, cancel = clearTimeout } = {}) {
    this.send = send; this.now = now; this.schedule = schedule; this.cancel = cancel;
    this.enabled = false; this.messages = []; this.timer = null; this.lastSent = -Infinity;
    this.dirty = false; this.refresh = false; this.lastText = '';
  }
  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) {
      this.cancel(this.timer); this.timer = null; this.messages = [];
      this.dirty = false; this.refresh = false; this.lastText = '';
    }
  }
  enqueue(message) {
    if (!this.enabled) return;
    this.messages = this.messages.filter(item => item.expires > this.now());
    this.messages.push({ ...message, expires: this.now() + maxAge });
    this.messages = this.messages.slice(-maxMessages);
    this.dirty = true; this.refresh = true; this.drain();
  }
  removeWhere(predicate) {
    const before = this.messages.length;
    this.messages = this.messages.filter(message => !predicate(message));
    if (this.messages.length !== before) { this.dirty = true; this.drain(); }
  }
  remove(id) { this.removeWhere(message => message.id === id); }
  removeUser(userId) { this.removeWhere(message => message.userId === userId); }
  drain() {
    if (!this.enabled || !this.dirty || this.timer !== null) return;
    const wait = interval - (this.now() - this.lastSent);
    if (wait > 0) {
      this.timer = this.schedule(() => { this.timer = null; this.drain(); }, wait);
      this.timer?.unref?.(); return;
    }
    this.messages = this.messages.filter(message => message.expires > this.now());
    const text = chatboxText(this.messages);
    // No heartbeat: a quiet chat should fade away normally in VRChat.
    if (text !== this.lastText || (this.refresh && text)) {
      this.send(text); this.lastSent = this.now(); this.lastText = text;
    }
    this.dirty = false; this.refresh = false;
  }
  close() { this.setEnabled(false); }
}
