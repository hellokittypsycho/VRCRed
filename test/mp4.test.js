import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mp4Relay } from '../lib/mp4.js';
test('fragment relay handles split boxes and retains a complete initialization and latest fragment', () => {
  const box = (type, data = '') => { const b = Buffer.alloc(8 + data.length); b.writeUInt32BE(b.length); b.write(type, 4); b.write(data, 8); return b; };
  const relay = new Mp4Relay(), fragments = [];
  const init = Buffer.concat([box('ftyp'), box('moov', 'codec')]);
  const fragment = Buffer.concat([box('moof', 'keyframe'), box('mdat', 'video-and-audio')]);
  const bytes = Buffer.concat([init, fragment]);
  for (let i = 0; i < bytes.length; i += 3) relay.push(bytes.subarray(i, i + 3), b => fragments.push(b));
  assert.deepEqual(relay.init, init); assert.deepEqual(relay.latest, fragment); assert.deepEqual(fragments, [fragment]);
  const bad = Buffer.alloc(8); bad.writeUInt32BE(100_000_000); assert.throws(() => relay.push(bad, () => {}), /Invalid/);
  relay.reset(); assert.equal(relay.init, null); assert.equal(relay.latest, null);
});
