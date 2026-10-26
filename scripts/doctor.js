import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let failed = false;
function check(ok, name, remedy) {
  console.log(`${ok ? 'OK' : 'CHECK'}  ${name}${ok ? '' : `\n       ${remedy}`}`);
  if (!ok) failed = true;
}
console.log('Chaos Deck setup check\nThis checks local prerequisites without changing accounts or stream settings.\n');
check(Number(process.versions.node.split('.')[0]) >= 24, `Node.js ${process.versions.node}`, 'Install Node.js 24 or newer from https://nodejs.org/');
check(process.platform === 'win32', 'Windows host for VRChat capture', 'Spout capture and process audio require Windows. Linux cloud relaying is not implemented yet.');
let python;
try { python = JSON.parse(readFileSync(path.join(root, '.camera-runtime.json'), 'utf8').replace(/^\uFEFF/, '')).python; } catch { /* Report missing setup below. */ }
const runtime = typeof python === 'string' && existsSync(python);
check(runtime, 'Camera runtime configured', 'Run Setup Camera.cmd. Install 64-bit Python 3.12 or 3.13 first if needed.');
if (runtime) {
  const result = spawnSync(python, ['-c', 'import sys;sys.path.insert(0,sys.argv[1]);import SpoutGL,av,PIL,proctap,sounddevice,numpy,scipy;print("Python %s; camera and audio imports passed" % sys.version.split()[0])', path.join(root, '.camera-deps')], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
  check(result.status === 0, result.status === 0 ? result.stdout.trim() : 'Camera and audio dependencies', 'Run Setup Camera.cmd again. The Python interpreter may have moved or a dependency is missing.');
}
console.log(`\n${existsSync(path.join(root, 'data', 'chaos-deck.sqlite')) ? 'Saved data found. Sign in with your existing account.' : 'New installation. The first visit to the local panel creates an admin account.'}`);
console.log('Next: start VRChat, enable OSC and Camera → Stream → Spout Stream, then open the panel.');
process.exitCode = failed ? 1 : 0;
