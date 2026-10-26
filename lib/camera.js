import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Mp4Relay } from './mp4.js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const marker = Buffer.from('CDK1');
const execFileAsync = promisify(execFile);
export class SpoutCamera {
  constructor({ spawnWorker = spawn, platform = process.platform, retryDelays = [1000, 2000, 4000, 8000, 15000], stallTimeout = 20000, healthInterval = 2000 } = {}) {
    this.spawnWorker = spawnWorker; this.platform = platform; this.retryDelays = retryDelays;
    this.stallTimeout = stallTimeout; this.healthInterval = healthInterval;
    this.worker = null; this.jpeg = null; this.clients = new Set(); this.enabled = false;
    this.retryTimer = null; this.healthTimer = null; this.retryAt = 0; this.attempts = 0; this.generation = 0;
    this.fps = 60; this.resolution = 1080; this.requestedSource = ''; this.frameTimes = []; this.relay = new Mp4Relay();
    this.audio = { game: true, microphone: true, device: null };
    this.details = { source: '', senders: [], width: 0, height: 0, frames: 0, lastFrame: 0, error: '', message: '' };
  }
  runtime() {
    try {
      const { python } = JSON.parse(readFileSync(path.join(root, '.camera-runtime.json'), 'utf8').replace(/^\uFEFF/, ''));
      return existsSync(python) && ['SpoutGL', 'av', 'proctap', 'sounddevice.py'].every(name => existsSync(path.join(root, '.camera-deps', name))) ? python : null;
    } catch { return null; }
  }
  configuration() {
    return { source: this.requestedSource, fps: this.fps, resolution: this.resolution, ...this.audio };
  }
  state() {
    const now = Date.now();
    this.frameTimes = this.frameTimes.filter(time => now - time <= 2000);
    const elapsed = this.frameTimes.at(-1) - this.frameTimes[0];
    const actualFps = this.worker && elapsed > 0 ? Math.round((this.frameTimes.length - 1) * 10000 / elapsed) / 10 : 0;
    const connected = !!this.worker && this.details.lastFrame > now - 3000;
    return { ...this.details, supported: this.platform === 'win32', installed: !!this.runtime(), running: !!this.worker,
      enabled: this.enabled, reconnecting: this.enabled && !connected, retryAt: this.retryAt, attempts: this.attempts, generation: this.generation,
      connected, requestedSource: this.requestedSource, fps: this.fps, resolution: this.resolution, audio: this.audio,
      ready: !!this.relay.init && !!this.relay.latest, actualFps: this.worker ? this.details.actualFps || actualFps : 0 };
  }
  async audioDevices() {
    const python = this.runtime();
    if (!python) throw new Error('Run Setup Camera.cmd first.');
    const { stdout } = await execFileAsync(python, ['-u', path.join(root, 'scripts', 'spout_camera.py'), '--devices'], { windowsHide: true, timeout: 10000 });
    return JSON.parse(stdout);
  }
  start(source = '', fps = 60, options = {}) {
    if (typeof source !== 'string' || source.length > 256 || (source && !/^vrc[^\x00-\x1f]*$/i.test(source))) throw new Error('Choose a VRChat Spout source');
    if (![720, 1080].includes(options.resolution ?? 1080)) throw new Error('Choose 720p or 1080p.');
    if (options.device != null && (!Number.isInteger(options.device) || options.device < 0 || options.device > 1000)) throw new Error('Choose a microphone device.');
    for (const key of ['game', 'microphone']) if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new Error('Invalid audio option.');
    if (![15, 30, 60].includes(fps)) throw new Error('Choose a stream frame rate of 15, 30, or 60 FPS.');
    if (!this.runtime()) throw new Error('Run Setup Camera.cmd once to install the local Spout receiver.');
    if (this.platform !== 'win32') throw new Error('Direct Spout capture requires Windows.');
    this.stop();
    this.enabled = true; this.requestedSource = source; this.fps = fps; this.resolution = options.resolution ?? 1080;
    this.audio = { game: options.game ?? true, microphone: options.microphone ?? true, device: options.device ?? null };
    this.launch();
  }
  launch() {
    if (!this.enabled) return;
    clearTimeout(this.retryTimer); this.retryTimer = null; this.retryAt = 0;
    this.stopWorker();
    this.details = { source: this.requestedSource, senders: [], width: 0, height: 0, frames: 0, lastFrame: 0, error: '', message: 'Connecting to VRChat camera…' };
    let worker;
    try {
      const python = this.runtime();
      if (!python) throw new Error('Camera runtime is unavailable.');
      worker = this.spawnWorker(python, ['-u', path.join(root, 'scripts', 'spout_camera.py'), this.requestedSource, String(this.fps), JSON.stringify({ ...this.audio, resolution: this.resolution, parentPid: process.pid })], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { this.queueRetry(error.message); return; }
    this.worker = worker; this.generation++; this.lastOutputAt = Date.now();
    let pending = Buffer.alloc(0);
    worker.stdout.on('data', chunk => {
      if (this.worker !== worker) return;
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 9) {
        const offset = pending.indexOf(marker);
        if (offset < 0) { pending = pending.subarray(-3); break; }
        if (offset > 0) pending = pending.subarray(offset);
        if (pending.length < 9) break;
        const kind = pending[4], size = pending.readUInt32BE(5);
        if (size > 8_000_000) { this.failed(worker, 'Invalid camera frame'); break; }
        if (pending.length < 9 + size) break;
        const payload = pending.subarray(9, 9 + size); pending = pending.subarray(9 + size);
        if (kind === 1) {
          try { Object.assign(this.details, JSON.parse(payload.toString('utf8'))); } catch { this.failed(worker, 'Invalid camera status'); break; }
        } else if (kind === 2 && payload[0] === 0xff && payload[1] === 0xd8) {
          this.jpeg = Buffer.from(payload); this.details.frames++; this.details.lastFrame = Date.now();
          this.details.message = ''; this.details.error = ''; this.attempts = 0;
          this.frameTimes.push(this.details.lastFrame); if (this.frameTimes.length > 240) this.frameTimes.shift();
        } else if (kind === 3) {
          try { this.relay.push(Buffer.from(payload), fragment => {
            this.lastOutputAt = Date.now();
            for (const client of this.clients) {
              if (client.destroyed || client.writableLength > 2_000_000) { client.end(); continue; }
              if (!client.deckInitialized && this.relay.init) { client.write(this.relay.init); client.deckInitialized = true; }
              client.write(fragment);
            }
          }); } catch (error) { this.failed(worker, error.message); break; }
        }
      }
    });
    worker.stderr.on('data', chunk => { if (this.worker === worker) this.details.error = chunk.toString('utf8').slice(-350); });
    worker.on('error', error => this.failed(worker, error.message));
    worker.on('exit', code => this.failed(worker, this.details.error || `Camera receiver stopped (${code ?? 'signal'}).`));
    this.healthTimer = setInterval(() => {
      if (this.worker === worker && Date.now() - this.lastOutputAt > this.stallTimeout) this.failed(worker, 'Camera receiver stopped responding.');
    }, this.healthInterval);
    this.healthTimer.unref();
  }
  failed(worker, message) {
    if (this.worker !== worker) return;
    this.stopWorker(); this.queueRetry(message);
  }
  queueRetry(message) {
    if (!this.enabled || this.retryTimer) return;
    this.details.error = message; this.details.message = 'Reconnecting to VRChat camera…';
    const delay = this.retryDelays[Math.min(this.attempts++, this.retryDelays.length - 1)];
    this.retryAt = Date.now() + delay;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.launch(); }, delay); this.retryTimer.unref();
  }
  stopWorker() {
    clearInterval(this.healthTimer); this.healthTimer = null;
    const worker = this.worker; this.worker = null;
    worker?.kill(); this.jpeg = null; this.frameTimes = []; this.relay.reset();
    for (const client of this.clients) client.end(); this.clients.clear();
  }
  stop() {
    this.enabled = false; this.attempts = 0; this.retryAt = 0;
    clearTimeout(this.retryTimer); this.retryTimer = null; this.stopWorker();
  }
  serve(req, res) {
    if (!this.worker || this.clients.size >= 8) { res.writeHead(503, { 'Retry-After': '2' }); res.end('Camera is reconnecting or has too many viewers'); return; }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'X-Accel-Buffering': 'no', Connection: 'keep-alive', 'Cross-Origin-Resource-Policy': 'same-origin' });
    res.flushHeaders(); this.clients.add(res);
    if (this.relay.init && this.relay.latest) { res.write(this.relay.init); res.write(this.relay.latest); res.deckInitialized = true; }
    res.on('close', () => { this.clients.delete(res); });
  }
}
