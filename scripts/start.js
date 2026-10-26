import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const major = Number(process.versions.node.split('.')[0]);
if (major < 24) {
  console.error(`Chaos Deck needs Node.js 24 or newer. You have ${process.versions.node}.\nDownload it from https://nodejs.org/ then open Start Chaos Deck.cmd again.`);
  process.exit(1);
}
const port = Number(process.env.PORT ?? 3210);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('PORT must be a whole number between 1 and 65535.'); process.exit(1);
}
const url = `http://127.0.0.1:${port}/`;
function openPanel() {
  if (process.platform === 'win32' && process.argv.includes('--open')) {
    execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true }, () => {});
  }
}
try {
  const response = await fetch(`${url}api/auth/session`, { signal: AbortSignal.timeout(800) });
  const existing = await response.json();
  if (response.ok && typeof existing.configured === 'boolean' && typeof existing.authenticated === 'boolean') {
    console.log(`Chaos Deck is already running.\nOpen ${url}\nKeep the original server window open.`);
    openPanel(); process.exit(0);
  }
} catch { /* Start a new server when the panel is not already running. */ }
console.log('Starting Chaos Deck…');
try {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  process.chdir(root);
  const { createApp } = await import('../server.js');
  const app = await createApp({ port });
  console.log(`\nCHAOS DECK\nOpen ${url}\n\nFirst visit? Create your admin account, then follow Help & setup.\nKeep this window open while streaming. Press Ctrl+C to stop.\n`);
  openPanel();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
} catch (error) {
  console.error(error.code === 'EADDRINUSE'
    ? `Port ${port} is being used by another app. Close it, or choose another port with the PORT environment variable.`
    : `Chaos Deck could not start: ${error.message}\nRun npm run doctor for setup checks.`);
  process.exit(1);
}
