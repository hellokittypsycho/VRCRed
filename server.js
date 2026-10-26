import http from 'node:http';
import dgram from 'node:dgram';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { encodeMessage, encodeArguments, decodePacket } from './lib/osc.js';
import { discoverAvatars } from './lib/avatars.js';
import { findOscQuery, readOscQueryValue, readOscQueryValues } from './lib/oscquery.js';
import { SpoutCamera } from './lib/camera.js';
import { createAccess } from './lib/access.js';
import { ChatRoom } from './lib/chat.js';
import { ChatRelay } from './lib/chat-relay.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const movements = {
  forward: ['Vertical', 'Float', 1], back: ['Vertical', 'Float', -1],
  left: ['Horizontal', 'Float', -1], right: ['Horizontal', 'Float', 1],
  turnLeft: ['LookHorizontal', 'Float', -1], turnRight: ['LookHorizontal', 'Float', 1],
  jump: ['Jump', 'Int', 1], run: ['Run', 'Int', 1],
};
const inputTypes = Object.fromEntries(Object.values(movements).map(([name, type]) => [`/input/${name}`, type]));
const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/controls.js': ['controls.js', 'text/javascript'], '/community.js': ['community.js', 'text/javascript'], '/camera.js': ['camera.js', 'text/javascript'], '/help.js': ['help.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const neutral = type => type === 'Bool' ? false : 0;

export async function createApp(options = {}) {
  const access = await createAccess(options.databaseFile ?? path.join(root, 'data', 'chaos-deck.sqlite'), { legacyFile: options.legacyAccessFile ?? (options.databaseFile ? undefined : path.join(root, '.deck-access.json')) });
  const chat = new ChatRoom(access.db);
  let movementOwner = null;
  let controlsActive = false, oscPort = options.oscPort ?? 9000;
  let avatars = await discoverAvatars(options.avatarRoot), selectedId = '', currentId = '';
  let lastRx = 0, rxCount = 0, txCount = 0, receiverError = '';
  let activePreset = null, lastPreset = 0, closing = false;
  let oscQuery = null, lastCommand = null, oscSentCount = 0;
  const values = new Map(), resets = new Map(), inputTimers = new Map(), presetTimers = new Set();
  const logs = [], listeners = new Map();
  const sender = dgram.createSocket('udp4');
  const chatRelay = new ChatRelay(text => sendPacket(encodeArguments('/chatbox/input', [
    { type: 'String', value: text }, { type: 'Bool', value: true }, { type: 'Bool', value: false },
  ])));
  chatRelay.setEnabled(access.db.prepare("SELECT value FROM settings WHERE key='chatRelayEnabled'").get()?.value === 'true');
  const receiver = dgram.createSocket('udp4');
  const camera = options.camera ?? new SpoutCamera();
  function saveCameraIntent(enabled) {
    access.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('cameraBroadcast',?)").run(JSON.stringify({ enabled, ...camera.configuration() }));
  }

  const selectedAvatar = () => avatars.find(a => a.id === selectedId);
  function log(message, kind = 'info') {
    logs.unshift({ id: randomBytes(5).toString('hex'), time: Date.now(), message, kind });
    logs.splice(60);
  }
  function snapshot() {
    return {
      controlsActive, oscPort, target: `127.0.0.1:${oscPort}`, rxPort,
      receiverError, lastRx, rxCount, txCount, activePreset, selectedId, currentId,
      avatars, values: Object.fromEntries(values), logs,
      oscObserved: lastRx > Date.now() - 15000,
      oscQueryAvailable: !!oscQuery, oscSentCount, lastCommand,
      camera: camera.state(),
      chatRelayEnabled: chatRelay.enabled,
    };
  }
  // rxPort is available even if another OSC app already owns the feedback port.
  let rxPort = options.receivePort ?? 9001;
  function state() {
    return { ...snapshot(), rxPort };
  }
  function broadcast() {
    for (const [res, session] of listeners) {
      if (!access.valid(session)) continue;
      if (res.writableLength > 4_000_000) { res.end(); continue; }
      res.write(`data: ${JSON.stringify(liveState(res, session))}\n\n`);
    }
  }
  function send(address, type, value) {
    sendPacket(encodeMessage(address, type, value));
  }
  function sendPacket(packet) {
    txCount++;
    sender.send(packet, oscPort, '127.0.0.1', error => {
      if (error) { log(`OSC send failed: ${error.message}`, 'error'); broadcast(); }
      else oscSentCount++;
    });
  }
  function beginControl() { controlsActive = true; }
  function viewState(session) {
    const result = { ...state(), role: session.role, user: { id: session.userId, username: session.username, role: session.role } };
    if (session.role === 'admin') return { ...result, publicOrigin: access.origin };
    return { ...result, avatars: [], values: {}, logs: [], selectedId: '', currentId: '',
      target: '', oscPort: 0, rxPort: 0, receiverError: '', lastCommand: null };
  }
  function liveState(res, session) {
    const result = viewState(session);
    result.online = new Set([...listeners.values()].filter(s => !s.revoked).map(s => s.userId)).size;
    if (session.role === 'admin') {
      const version = JSON.stringify(avatars.map(a => [a.id, a.modified, a.parameters.length]));
      if (res.avatarVersion === version) delete result.avatars;
      res.avatarVersion = version;
    }
    return result;
  }
  function pushEvent(name, data) {
    for (const [res, session] of listeners) {
      if (!access.valid(session) || res.destroyed) continue;
      if (res.writableLength > 4_000_000) { res.end(); continue; }
      res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  }
  function presence() {
    if (closing) return;
    const users = new Set([...listeners.values()].filter(s => !s.revoked).map(s => s.userId));
    pushEvent('presence', { online: users.size });
  }
  access.onRevoke = session => {
    if (movementOwner === session.id) { movementOwner = null; pause('Admin session ended · movement released'); }
  };
  function cancelPreset() {
    for (const timer of presetTimers) clearTimeout(timer);
    presetTimers.clear();
    activePreset = null;
  }
  function releaseInputs() {
    for (const timer of inputTimers.values()) clearTimeout(timer);
    inputTimers.clear();
    for (const [address, type] of Object.entries(inputTypes)) send(address, type, 0);
  }
  function stop(reason = 'All controls released', restore = true, disarm = true) {
    cancelPreset();
    if (controlsActive || resets.size || inputTimers.size) {
      releaseInputs();
      if (restore) for (const [address, original] of resets) send(address, original.type, original.value);
    }
    resets.clear();
    if (disarm) controlsActive = false;
    log(reason, 'stop');
    broadcast();
  }
  function pause(reason = 'Deck paused · avatar settings kept') {
    // Losing browser visibility must release movement, without undoing latched toggles.
    if (activePreset === 'emote') {
      const emote = selectedAvatar()?.parameters.find(p => p.name === 'VRCEmote' || p.name.endsWith('/VRCEmote'));
      const original = resets.get(emote?.address);
      if (original) { send(emote.address, original.type, original.value); resets.delete(emote.address); }
    }
    cancelPreset();
    if (controlsActive || inputTimers.size) releaseInputs();
    controlsActive = false; log(reason, 'stop'); broadcast();
  }
  function move(name, duration = 350) {
    beginControl();
    const input = movements[name];
    if (!input) throw fail('Unknown movement');
    if (!Number.isInteger(duration) || duration < 50 || duration > 2000) throw fail('Duration must be 50–2000 ms');
    const [key, type, value] = input, address = `/input/${key}`;
    clearTimeout(inputTimers.get(address));
    send(address, type, value);
    lastCommand = { address, value, status: 'sent', time: Date.now() };
    inputTimers.set(address, setTimeout(() => {
      send(address, type, 0);
      inputTimers.delete(address);
      broadcast();
    }, duration));
  }
  function validateParameter(body) {
    const { address, type, value } = body;
    if (typeof address !== 'string' || !/^\/avatar\/parameters\/[^\x00-\x1f\x7f]{1,512}$/.test(address)) throw fail('Enter a valid /avatar/parameters/ address');
    if (!['Int', 'Float', 'Bool'].includes(type)) throw fail('Choose Int, Float, or Bool');
    if (type === 'Bool' ? typeof value !== 'boolean' : !Number.isFinite(value)) throw fail('Parameter value has the wrong type');
    if (type === 'Int' && (!Number.isInteger(value) || value < -2147483648 || value > 2147483647)) throw fail('Int must fit a signed 32-bit value');
    if (type === 'Float' && Math.abs(value) > 1) throw fail('Float must be between -1 and 1');
    const known = selectedAvatar()?.parameters.find(p => p.address === address);
    if (known && known.type !== type) throw fail(`This parameter expects ${known.type}`);
    return { address, type, value };
  }
  function setParameter(body) {
    beginControl();
    const { address, type, value } = validateParameter(body);
    if (!resets.has(address)) {
      if (resets.size >= 128) throw fail('Use Restore changes before changing more parameters');
      const known = selectedAvatar()?.parameters.find(p => p.address === address);
      const observed = values.get(known?.outputAddress || address);
      const baseline = observed !== undefined ? observed : neutral(type);
      const valid = type === 'Bool' ? typeof baseline === 'boolean' : Number.isFinite(baseline);
      resets.set(address, { type, value: valid ? baseline : neutral(type) });
    }
    send(address, type, value);
    lastCommand = { address, value, status: 'sent', time: Date.now() };
    log(`Sent ${address.split('/').at(-1)} → ${value}`, 'parameter');
  }
  function schedule(fn, ms) {
    const timer = setTimeout(() => { presetTimers.delete(timer); fn(); broadcast(); }, ms);
    presetTimers.add(timer);
  }
  function preset(name) {
    beginControl();
    if (!['spin', 'wiggle', 'hops', 'emote'].includes(name)) throw fail('Unknown preset');
    if (activePreset) throw fail('A preset is already running. Stop it first.', 409);
    if (Date.now() - lastPreset < 1500) throw fail('Preset is cooling down', 429);
    const emote = selectedAvatar()?.parameters.find(p => (p.name === 'VRCEmote' || p.name.endsWith('/VRCEmote')) && p.type === 'Int');
    if (name === 'emote' && !emote) throw fail('Select an avatar that exposes VRCEmote, or use a custom parameter.');
    activePreset = name; lastPreset = Date.now();
    log(`Started ${name}`, 'preset');
    if (name === 'spin') move('turnRight', 2000);
    if (name === 'wiggle') for (let i = 0; i < 8; i++) schedule(() => move(i % 2 ? 'right' : 'left', 220), i * 260);
    if (name === 'hops') for (let i = 0; i < 3; i++) schedule(() => move('jump', 130), i * 600);
    if (name === 'emote') setParameter({ ...emote, value: 1 });
    schedule(() => {
      if (name === 'emote') {
        const original = resets.get(emote.address);
        if (original) send(emote.address, original.type, original.value);
        resets.delete(emote.address);
      }
      activePreset = null;
      log(`${name} finished`, 'info');
    }, 2400);
  }

  sender.on('error', error => { log(`OSC sender: ${error.message}`, 'error'); broadcast(); });
  await new Promise(resolve => sender.bind(0, '127.0.0.1', resolve));
  let receiverBound = false;
  receiver.on('message', (packet, remote) => {
    if (remote.address !== '127.0.0.1') return;
    try {
      const messages = decodePacket(packet);
      lastRx = Date.now(); rxCount++;
      for (const { address, args } of messages) {
        if (address === '/avatar/change' && typeof args[0] === 'string' && /^avtr_[\w-]+$/.test(args[0])) {
          if (currentId !== args[0]) {
            stop('Avatar changed. Controls released; choose your avatar.', false);
            currentId = args[0]; selectedId = avatars.some(a => a.id === currentId) ? currentId : ''; values.clear();
            // VRChat writes new avatar configs after the change notification.
            const changedId = currentId;
            const refresh = async () => {
              if (closing || currentId !== changedId) return;
              try {
                avatars = await discoverAvatars(options.avatarRoot);
                if (currentId === changedId && avatars.some(a => a.id === changedId)) selectedId = changedId;
                broadcast();
              } catch { /* Manual rescan remains available. */ }
            };
            void refresh();
            const retry = setTimeout(refresh, 1500); retry.unref();
          }
        } else if (address.startsWith('/avatar/parameters/') && args.length && values.size < 2000) values.set(address, args[0]);
      }
    } catch { /* Ignore unrelated or malformed datagrams. */ }
  });
  await new Promise(resolve => {
    receiver.once('error', error => { receiverError = `Feedback unavailable: ${error.message}. Sending still works.`; log(receiverError, 'error'); resolve(); });
    receiver.bind(rxPort, '127.0.0.1', () => { receiverBound = true; rxPort = receiver.address().port; resolve(); });
  });
  receiver.on('error', error => { receiverError = error.message; });
  if (options.oscQuery !== false) {
    oscQuery = options.oscQuery ?? (options.avatarRoot ? null : await findOscQuery());
    if (oscQuery) {
      try {
        for (const [address, value] of await readOscQueryValues(oscQuery.port)) values.set(address, value);
        const id = await readOscQueryValue(oscQuery.port, '/avatar/change');
        if (typeof id === 'string' && avatars.some(a => a.id === id)) { currentId = id; selectedId = id; }
        log(`VRChat OSCQuery connected · ${values.size} current values loaded`);
      } catch { log('OSCQuery value sync unavailable; UDP feedback remains active.'); }
    }
  }
  try {
    const saved = JSON.parse(access.db.prepare("SELECT value FROM settings WHERE key='cameraBroadcast'").get()?.value || 'null');
    if (saved?.enabled) { camera.start(saved.source ?? '', saved.fps ?? 60, saved); log('Resuming the active camera stream'); }
  } catch (error) { log(`Camera could not resume: ${error.message}`, 'error'); }
  log('Deck ready. Sign in to use avatar controls.');

  const server = http.createServer(async (req, res) => {
    const allowedHost = `127.0.0.1:${server.address().port}`;
    const localHost = `localhost:${server.address().port}`;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
    res.setHeader('Cache-Control', 'no-store');
    try {
      const hostIsLocal = [allowedHost, localHost].includes(req.headers.host);
      const remoteOrigin = access.origin;
      const publicHost = remoteOrigin && new URL(remoteOrigin).host;
      if (!hostIsLocal && req.headers.host !== publicHost) throw fail('Public address not configured. On the host PC, save this HTTPS address in Settings → Sharing & access.', 403);
      const origins = [`http://${allowedHost}`, `http://${localHost}`, ...(remoteOrigin ? [remoteOrigin] : [])];
      if (req.headers.origin && !origins.includes(req.headers.origin)) throw fail('Same-origin requests required', 403);
      const url = new URL(req.url, `http://${allowedHost}`);
      if (req.headers['sec-fetch-site'] === 'cross-site' && (url.pathname.startsWith('/api/') || req.method !== 'GET')) throw fail('Same-origin requests required', 403);
      const secure = !hostIsLocal || !!req.headers['x-forwarded-proto'];
      const localSetup = hostIsLocal && !req.headers['x-forwarded-for'] && !req.headers['x-forwarded-host'] && !req.headers['x-forwarded-proto'];
      const session = access.authenticate(req);
      if (req.method === 'GET' && url.pathname === '/api/auth/session') return json(res, { configured: access.configured, localSetup, authenticated: !!session, role: session?.role, user: session ? { id: session.userId, username: session.username, role: session.role } : undefined, migrated: access.migrated, token: session?.csrf });
      if (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/auth/') && !session) throw fail('Sign in to continue.', 401);
      if (req.method === 'GET' && url.pathname === '/api/events') {
        if (listeners.size >= 64 || session.resources.size >= 4) throw fail('Too many panel connections.', 429);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        listeners.set(res, session); access.attach(session, res); res.write(`data: ${JSON.stringify(liveState(res, session))}\n\n`);
        res.write(`event: chat-history\ndata: ${JSON.stringify({ messages: chat.history() })}\n\n`); presence();
        res.on('close', () => { listeners.delete(res); presence(); }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/chat') return json(res, { messages: chat.history(url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined) });
      if (req.method === 'GET' && url.pathname === '/api/accounts') return json(res, { users: access.users(session) });
      if (req.method === 'GET' && url.pathname === '/api/invites') return json(res, { invites: access.invites(session) });
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, { ...viewState(session), token: session.csrf });
      if (req.method === 'GET' && url.pathname.startsWith('/api/camera/')) {
        if (req.headers['sec-fetch-site'] === 'cross-site') throw fail('Same-origin camera requests required', 403);
        if (url.pathname === '/api/camera/stream') { camera.serve(req, res); access.attach(session, res); return; }
        if (url.pathname === '/api/camera/frame') {
          if (!camera.jpeg || !camera.state().connected) throw fail('No current camera frame', 404);
          res.writeHead(200, { 'Content-Type': 'image/jpeg' }); res.end(camera.jpeg); return;
        }
      }
      if (req.method === 'GET' && assets[url.pathname]) {
        const [file, mime] = assets[url.pathname];
        res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` });
        res.end(await readFile(path.join(root, 'public', file))); return;
      }
      if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) throw fail('Not found', 404);
      const origin = req.headers.origin;
      if (origin && !origins.includes(origin)) throw fail('Same-origin requests required', 403);
      const authenticationRoute = ['/api/auth/setup', '/api/auth/login', '/api/auth/register'].includes(url.pathname);
      if (!authenticationRoute && (!session || req.headers['x-deck-token'] !== session.csrf)) throw fail('Refresh the panel to reconnect', session ? 403 : 401);
      if (!req.headers['content-type']?.startsWith('application/json')) throw fail('JSON required', 415);
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 8192) throw fail('Request too large', 413); }
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { throw fail('Invalid JSON'); }
      if (!body || Array.isArray(body) || typeof body !== 'object') throw fail('JSON object required');
      if (url.pathname === '/api/auth/setup') {
        if (!localSetup) throw fail('Set up passwords on the host PC at localhost first.', 403);
        const created = await access.setup(body, res, false);
        return json(res, { ok: true, role: created.role, token: created.csrf });
      }
      if (['/api/auth/login', '/api/auth/register'].includes(url.pathname)) {
        const signedIn = await access[url.pathname.endsWith('/register') ? 'register' : 'login'](body, req, res, secure);
        return json(res, { ok: true, role: signedIn.role, token: signedIn.csrf });
      }
      if (url.pathname === '/api/auth/logout') { access.logout(session, res); return json(res, { ok: true }); }
      if (url.pathname === '/api/auth/password') {
        const updated = await access.changePassword(body, session, res, secure);
        return json(res, { ok: true, token: updated.csrf });
      }
      if (url.pathname === '/api/chat/send') {
        const message = chat.post(body, session); pushEvent('chat', { message }); chatRelay.enqueue(message); return json(res, { ok: true, message });
      }
      access.requireAdmin(session);
      if (!['/api/release', '/api/pause'].includes(url.pathname)) access.rateCommand(session);
      if (url.pathname === '/api/accounts/update') { access.updateUser(body, session); chatRelay.removeUser(body.id); return json(res, { users: access.users(session) }); }
      if (url.pathname === '/api/invites/create') return json(res, access.createInvite(body, session));
      if (url.pathname === '/api/invites/revoke') { access.revokeInvite(body, session); return json(res, { invites: access.invites(session) }); }
      if (url.pathname === '/api/chat/remove') { const message = chat.remove(body); chatRelay.remove(message.id); pushEvent('chat', { message }); return json(res, { ok: true }); }
      if (['/api/move', '/api/preset'].includes(url.pathname)) {
        if (movementOwner && movementOwner !== session.id && (inputTimers.size || activePreset)) throw fail('Someone else is using movement. Try again in a moment.', 409);
        movementOwner = session.id;
      }
      switch (url.pathname) {
        case '/api/chat/relay':
          if (typeof body.enabled !== 'boolean') throw fail('Choose whether to relay stream chat.');
          access.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('chatRelayEnabled',?)").run(String(body.enabled));
          chatRelay.setEnabled(body.enabled); log(`VRChat chat relay ${body.enabled ? 'enabled' : 'disabled'}`); break;
        case '/api/camera/start':
          try { camera.start(body.source ?? '', body.fps ?? 60, body); saveCameraIntent(true); } catch (error) { throw fail(error.message, 409); }
          log('VRChat stream requested'); break;
        case '/api/camera/stop': saveCameraIntent(false); camera.stop(); log('Camera stream disconnected'); break;
        case '/api/pause':
          if (movementOwner === session.id) { pause('Movement released'); movementOwner = null; }
          break;
        case '/api/settings':
          if (Object.keys(body).some(key => key !== 'oscPort') || !Number.isInteger(body.oscPort) || body.oscPort < 1 || body.oscPort > 65535) throw fail('Enter a valid OSC port. Only oscPort can be changed here.');
          if (controlsActive) pause('Connection settings changed');
          oscPort = body.oscPort; log(`Connection set to live OSC on port ${oscPort}`); break;
        case '/api/move': move(body.name, body.duration ?? 350); break;
        case '/api/release': if (movementOwner === session.id) releaseInputs(); break;
        case '/api/access/origin': await access.updateOrigin(body.origin); break;
        case '/api/audio/devices': return json(res, { devices: await camera.audioDevices() });
        case '/api/preset': preset(body.name); break;
        case '/api/parameter': {
          beginControl();
          const parameter = validateParameter(body);
          const output = selectedAvatar()?.parameters.find(p => p.address === parameter.address)?.outputAddress || parameter.address;
          const beforeAvatar = selectedId;
          if (oscQuery) {
            try { const value = await readOscQueryValue(oscQuery.port, output); if (value !== undefined) values.set(output, value); } catch { /* Fall back to UDP feedback. */ }
          }
          if (selectedId !== beforeAvatar) throw fail('Avatar changed during the command; try again', 409);
          access.requireAdmin(session);
          setParameter(body);
          const command = lastCommand;
          if (oscQuery) {
            await new Promise(resolve => setTimeout(resolve, 160));
            try {
              const observed = await readOscQueryValue(oscQuery.port, output);
              if (observed !== undefined) values.set(output, observed);
              if (lastCommand === command) {
                const matches = typeof observed === 'number' && typeof parameter.value === 'number' ? Math.abs(observed - parameter.value) < 0.001 : observed === parameter.value;
                command.status = matches ? 'confirmed' : 'unconfirmed'; command.observed = observed;
                log(matches ? `VRChat confirmed ${parameter.address.split('/').at(-1)} → ${observed}` : `Sent ${parameter.address.split('/').at(-1)}; VRChat reports ${observed ?? 'no value'} (avatar logic may override it)`, matches ? 'confirmed' : 'info');
              }
            } catch { /* The send result remains honest if OSCQuery is unavailable. */ }
          }
          break;
        }
        case '/api/restore': stop('Inputs released and parameter baselines restored', true, false); break;
        case '/api/avatar':
          if (typeof body.id !== 'string' || (body.id && !avatars.some(a => a.id === body.id))) throw fail('Unknown avatar');
          if (currentId && body.id && currentId !== body.id) throw fail('This is not the avatar reported by VRChat. Reload the avatar list.', 409);
          stop('Avatar controls loaded · controls released'); selectedId = body.id; break;
        case '/api/rescan': avatars = await discoverAvatars(options.avatarRoot); if (!selectedId && avatars.some(a => a.id === currentId)) selectedId = currentId; log(`Found ${avatars.length} avatar configurations`); break;
        default: throw fail('Not found', 404);
      }
      broadcast();
      json(res, { ok: true });
    } catch (error) {
      if (!res.headersSent) json(res, { error: error.status ? error.message : 'Internal server error' }, error.status ?? 500);
      else res.end();
    }
  });
  // Input holds and cues have their own bounded lifetimes; this publishes live state.
  const watchdog = setInterval(broadcast, 500);
  watchdog.unref();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 3210, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}`, state,
    async close() {
      if (closing) return; closing = true;
      stop('Server shutting down'); clearInterval(watchdog);
      chatRelay.close();
      camera.stop();
      access.close();
      for (const res of listeners.keys()) res.end();
      if (receiverBound) receiver.close();
      await new Promise(resolve => sender.close(resolve));
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    },
  };
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3210);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
  const app = await createApp({ port });
  console.log(`\n  CHAOS DECK · VRChat OSC\n  ${app.url}\n  Open the panel locally to sign in or create the first admin account. Enable OSC in VRChat.\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
}
