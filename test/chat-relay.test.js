import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatRelay, chatboxText } from '../lib/chat-relay.js';
import { encodeArguments, decodePacket } from '../lib/osc.js';

function clockRelay() {
  let now = 0, nextId = 0;
  const timers = new Map(), sent = [];
  const relay = new ChatRelay(text => sent.push(text), {
    now: () => now,
    schedule(fn, wait) { const id = ++nextId; timers.set(id, { fn, due: now + wait }); return id; },
    cancel(id) { timers.delete(id); },
  });
  return { relay, sent, advance(ms) {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.fn(); }
  } };
}
const message = (id, text = `Hello ${id}`, username = 'Mosa') => ({ id, userId: 7, username, text });

test('chatbox lays out a shared heading and three attributed messages within one OSC update', () => {
  const text = chatboxText([message(1, 'Hello\n guys!'), message(2, 'Hey!', 'Nis'), message(3, 'Boop!', 'Alex')]);
  assert.equal(text, 'STREAM CHAT\nMosa › Hello guys!\nNis › Hey!\nAlex › Boop!');
  assert.equal(chatboxText([]), '');
  const packet = encodeArguments('/chatbox/input', [
    { type: 'String', value: text }, { type: 'Bool', value: true }, { type: 'Bool', value: false },
  ]);
  assert.deepEqual(decodePacket(packet), [{ address: '/chatbox/input', args: [text, true, false] }]);
});

test('chatbox shares character space, preserves full names and avoids broken emoji or graphemes', () => {
  const family = '👨‍👩‍👧‍👦';
  const text = chatboxText([message(1, 'x'.repeat(500), 'a'.repeat(24)), message(2, family.repeat(50), 'b'.repeat(24)), message(3, 'Hi', 'c'.repeat(24))]);
  assert.ok(text.length <= 144); assert.ok(text.isWellFormed());
  const lines = text.split('\n'); assert.equal(lines.length, 4);
  assert.ok(lines[1].startsWith(`${'a'.repeat(24)} › `)); assert.ok(lines[1].endsWith('…'));
  const emojiBody = lines[2].split(' › ')[1];
  assert.equal(emojiBody.replaceAll(family, '').replace('…', ''), '');
  assert.equal(lines[3], `${'c'.repeat(24)} › Hi`);
  assert.equal(chatboxText([message(1, 'x'.repeat(500))]).length, 144);
});

test('relay coalesces bursts into the latest three messages and preserves already displayed context', () => {
  const { relay, sent, advance } = clockRelay();
  relay.enqueue(message(0)); assert.equal(sent.length, 0);
  relay.setEnabled(true); relay.enqueue(message(1)); relay.enqueue(message(2)); relay.enqueue(message(3));
  assert.deepEqual(sent, ['STREAM CHAT\nMosa › Hello 1']);
  advance(2999); assert.equal(sent.length, 1);
  advance(1); assert.equal(sent.at(-1), 'STREAM CHAT\nMosa › Hello 1\nMosa › Hello 2\nMosa › Hello 3');
  for (let id = 4; id <= 20; id++) relay.enqueue(message(id));
  assert.equal(relay.messages.length, 3);
  advance(3000); assert.equal(sent.at(-1), 'STREAM CHAT\nMosa › Hello 18\nMosa › Hello 19\nMosa › Hello 20');
  advance(30000); assert.equal(sent.length, 3, 'quiet chat is not repeatedly broadcast');
});

test('moderation removes retained and pending messages; disabling clears the feed and cancels work', () => {
  const { relay, sent, advance } = clockRelay(); relay.setEnabled(true);
  relay.enqueue(message(1)); relay.enqueue(message(2)); relay.enqueue(message(3));
  relay.remove(2); advance(3000);
  assert.equal(sent.at(-1), 'STREAM CHAT\nMosa › Hello 1\nMosa › Hello 3');
  relay.remove(1); advance(3000); assert.equal(sent.at(-1), 'STREAM CHAT\nMosa › Hello 3');
  relay.removeUser(7); advance(3000); assert.equal(sent.at(-1), '', 'an emptied moderated feed clears the chatbox');
  relay.enqueue(message(4)); relay.setEnabled(false); advance(3000); assert.equal(sent.length, 4);
  relay.setEnabled(true); advance(3000); assert.equal(sent.length, 4, 'enabling never replays history');
  relay.enqueue(message(5)); assert.equal(sent.at(-1), 'STREAM CHAT\nMosa › Hello 5');
  relay.enqueue(message(6)); relay.close(); advance(3000); assert.equal(sent.length, 5);
});

test('expired context is excluded when fresh chat resumes, without cutting the global cooldown short', () => {
  const { relay, sent, advance } = clockRelay(); relay.setEnabled(true); relay.enqueue(message(1));
  relay.setEnabled(false); relay.setEnabled(true); relay.enqueue(message(2));
  advance(2999); assert.equal(sent.length, 1);
  advance(1); assert.equal(sent.at(-1), 'STREAM CHAT\nMosa › Hello 2');
  advance(31000); relay.enqueue(message(3)); assert.equal(sent.at(-1), 'STREAM CHAT\nMosa › Hello 3');
  relay.enqueue(message(4)); advance(31000);
  assert.equal(sent.at(-1), '', 'stale pending context is cleared rather than replayed');
});
