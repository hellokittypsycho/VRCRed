import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.js';
import { encodeMessage, decodePacket } from '../lib/osc.js';
import { discoverAvatars } from '../lib/avatars.js';

async function startTestApp(t, options) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deck-access-test-'));
  const app = await createApp({ ...options, databaseFile: path.join(directory, 'deck.sqlite') });
  const response = await fetch(`${app.url}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'TestAdmin', password: 'host-test-password-123' }) });
  assert.equal(response.status, 200);
  app.testCookie = response.headers.get('set-cookie').split(';')[0];
  t.after(async () => { await app.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); await rm(directory, { recursive: true, force: true }); });
  return app;
}

async function until(predicate, timeout = 2000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw new Error('Timed out waiting for state'); await delay(20); }
}

test('OSC uses network byte order, UTF-8 padding, booleans and bundles', () => {
  assert.equal(encodeMessage('/input/Jump', 'Int', 1).toString('hex'), '2f696e7075742f4a756d70002c69000000000001');
  for (const [type, value] of [['Int', -123], ['Float', 0.5], ['Bool', true], ['Bool', false], ['String', 'hello 👋']]) {
    assert.deepEqual(decodePacket(encodeMessage('/test', type, value)), [{ address: '/test', args: [value] }]);
  }
  const packet = encodeMessage('/avatar/parameters/Hat', 'Bool', true);
  const size = Buffer.alloc(4); size.writeInt32BE(packet.length);
  const bundle = Buffer.concat([Buffer.from('#bundle\0'), Buffer.alloc(8), size, packet]);
  assert.equal(decodePacket(bundle)[0].args[0], true);
  assert.throws(() => decodePacket(bundle.subarray(0, -1)), /bundle/);
  assert.throws(() => decodePacket(Buffer.from('/bad')));
  assert.throws(() => decodePacket(Buffer.alloc(8)));
});

test('avatar discovery loads writable parameters and tolerates malformed configs', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chaos-avatar-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'usr_test', 'Avatars'); await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'avtr_test.json'), '\uFEFF' + JSON.stringify({ name: 'Test avatar', parameters: [
    { name: 'Hat', input: { address: '/avatar/parameters/Hat', type: 'Bool' } },
    { name: 'VelocityZ', output: { address: '/avatar/parameters/VelocityZ', type: 'Float' } },
  ] }));
  await writeFile(path.join(folder, 'avtr_broken.json'), '{');
  const avatars = await discoverAvatars(root);
  assert.equal(avatars.length, 1); assert.equal(avatars[0].id, 'avtr_test');
  assert.deepEqual(avatars[0].parameters.map(p => p.name), ['Hat']);
  assert.deepEqual(await discoverAvatars(path.join(root, 'missing')), []);
});

test('HTTP bridge sends real OSC to a mock receiver, releases inputs, restores parameters and rejects foreign requests', async t => {
  const mock = dgram.createSocket('udp4'); const received = [];
  mock.on('message', packet => received.push(...decodePacket(packet)));
  await new Promise(resolve => mock.bind(0, '127.0.0.1', resolve));
  const app = await startTestApp(t, { port: 0, oscPort: mock.address().port, receivePort: 0, avatarRoot: path.join(os.tmpdir(), 'chaos-deck-no-avatars') });
  t.after(async () => { await app.close(); mock.close(); });
  const initial = await (await fetch(`${app.url}/api/state`, { headers: { Cookie: app.testCookie } })).json();
  const headers = { Cookie: app.testCookie, 'Content-Type': 'application/json', 'X-Deck-Token': initial.token };
  async function post(route, body = {}, extraHeaders = {}) {
    return fetch(`${app.url}/api/${route}`, { method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body) });
  }
  assert.equal(initial.dryRun, undefined); assert.equal(initial.controlsActive, false);
  assert.equal((await fetch(app.url)).status, 200);
  assert.equal((await fetch(`${app.url}/app.js`)).status, 200);
  assert.equal((await fetch(`${app.url}/controls.js`)).status, 200);
  assert.equal((await fetch(`${app.url}/camera.js`)).status, 200);
  assert.equal((await fetch(`${app.url}/api/camera/frame`, { headers: { Cookie: app.testCookie } })).status, 404);
  assert.equal((await fetch(`${app.url}/api/camera/frame`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await post('camera/start', { source: 'OtherApplication' })).status, 409);
  for (const fps of [0, 120, -1, '60']) assert.equal((await post('camera/start', { fps })).status, 409);
  assert.equal((await post('arm', { armed: true }, { Origin: 'https://foreign.example' })).status, 403);
  assert.equal((await post('arm', { armed: true }, { 'X-Deck-Token': 'bad' })).status, 403);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const req = http.get(`${app.url}/api/state`, { headers: { Host: 'foreign.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await post('arm', { armed: true })).status, 404);
  assert.equal((await post('activate')).status, 404);
  assert.equal((await post('settings', { dryRun: true, oscPort: 9000 })).status, 400);
  await post('settings', { oscPort: mock.address().port });
  assert.equal((await post('move', { name: 'unknown' })).status, 400);
  assert.equal((await post('move', { name: 'forward', duration: 99999 })).status, 400);
  await post('move', { name: 'forward', duration: 60 });
  await until(() => received.some(m => m.address === '/input/Vertical' && m.args[0] === 0));
  assert.equal(received.find(m => m.address === '/input/Vertical').args[0], 1);
  assert.equal((await post('parameter', { address: '/input/Voice', type: 'Bool', value: true })).status, 400);
  assert.equal((await post('parameter', { address: '/avatar/parameters/Hat', type: 'Bool', value: 1 })).status, 400);
  assert.equal((await post('parameter', { address: '/avatar/parameters/Float', type: 'Float', value: 2 })).status, 400);
  assert.equal((await post('parameter', { address: '/avatar/parameters/Int', type: 'Int', value: 1.1 })).status, 400);
  assert.equal((await post('parameter', { address: '/avatar/parameters/Clothes/Color H E T', type: 'Float', value: 0.5 })).status, 200);
  assert.equal((await post('parameter', { address: '/avatar/parameters/Bad\u0000Name', type: 'Bool', value: true })).status, 400);
  mock.send(encodeMessage('/avatar/parameters/Hat', 'Bool', true), app.state().rxPort, '127.0.0.1');
  await until(() => app.state().values['/avatar/parameters/Hat'] === true);
  await post('parameter', { address: '/avatar/parameters/Hat', type: 'Bool', value: false });
  await post('parameter', { address: '/avatar/parameters/Unknown', type: 'Int', value: 5 });
  await post('restore');
  await until(() => received.filter(m => m.address === '/avatar/parameters/Hat').length === 2);
  assert.deepEqual(received.filter(m => m.address === '/avatar/parameters/Hat').map(m => m.args[0]), [false, true]);
  await until(() => received.filter(m => m.address === '/avatar/parameters/Unknown').length === 2);
  assert.deepEqual(received.filter(m => m.address === '/avatar/parameters/Unknown').map(m => m.args[0]), [5, 0]);
  assert.equal((await post('preset', { name: 'emote' })).status, 400);
  await post('preset', { name: 'wiggle' });
  assert.equal((await post('preset', { name: 'hops' })).status, 409);
  assert.equal((await post('stop')).status, 404, 'the removed stop feature has no API endpoint');
  await post('pause'); await delay(70); const countAfterStop = received.length;
  await delay(700);
  assert.equal(received.length, countAfterStop, 'pause must cancel future preset packets');
  assert.equal(app.state().controlsActive, false);
  await post('move', { name: 'right', duration: 80 });
  await delay(110);
  assert.equal(received.filter(m => m.address === '/input/Horizontal').at(-1).args[0], 0);
  mock.send(encodeMessage('/avatar/change', 'String', 'avtr_new'), app.state().rxPort, '127.0.0.1');
  await until(() => app.state().currentId === 'avtr_new');
  assert.equal(app.state().controlsActive, false);
});

test('a busy feedback port reports the conflict without disabling the panel', async t => {
  const blocker = dgram.createSocket('udp4');
  await new Promise(resolve => blocker.bind(0, '127.0.0.1', resolve));
  const app = await startTestApp(t, { port: 0, receivePort: blocker.address().port, oscQuery: false });
  t.after(async () => { await app.close(); blocker.close(); });
  const response = await fetch(`${app.url}/api/state`, { headers: { Cookie: app.testCookie } }); const state = await response.json();
  assert.equal(response.status, 200); assert.match(state.receiverError, /Feedback unavailable/);
});

test('admin commands send live and OSCQuery confirms changes and supplies restore baselines', async t => {
  let hatValue = true;
  const mock = dgram.createSocket('udp4');
  const received = [];
  mock.on('message', packet => {
    for (const message of decodePacket(packet)) {
      received.push(message);
      if (message.address === '/avatar/parameters/Hat') hatValue = message.args[0];
    }
  });
  await new Promise(resolve => mock.bind(0, '127.0.0.1', resolve));
  const query = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const hat = { FULL_PATH: '/avatar/parameters/Hat', VALUE: [hatValue] };
    res.end(JSON.stringify(req.url === '/avatar/parameters' ? { CONTENTS: { Hat: hat } } : req.url === '/avatar/change' ? { VALUE: ['avtr_query'] } : hat));
  });
  await new Promise(resolve => query.listen(0, '127.0.0.1', resolve));
  const app = await startTestApp(t, { port: 0, oscPort: mock.address().port, receivePort: 0,
    avatarRoot: path.join(os.tmpdir(), 'chaos-deck-no-avatars'), oscQuery: { port: query.address().port } });
  t.after(async () => { await app.close(); mock.close(); await new Promise(resolve => query.close(resolve)); });
  const state = await (await fetch(`${app.url}/api/state`, { headers: { Cookie: app.testCookie } })).json();
  async function post(route, body = {}) {
    const response = await fetch(`${app.url}/api/${route}`, { method: 'POST', headers: { Cookie: app.testCookie, 'Content-Type': 'application/json', 'X-Deck-Token': state.token }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.text());
  }
  const parameter = { address: '/avatar/parameters/Hat', type: 'Bool', value: false };
  await post('parameter', parameter);
  assert.equal(hatValue, false); assert.equal(app.state().lastCommand.status, 'confirmed');
  assert.equal(app.state().oscSentCount, 1);
  await post('pause'); await delay(50);
  assert.equal(hatValue, false, 'hiding the panel must keep the selected avatar setting');
  await post('restore'); await until(() => hatValue === true);
  assert.equal(received.filter(m => m.address === parameter.address).at(-1).args[0], true);
});
