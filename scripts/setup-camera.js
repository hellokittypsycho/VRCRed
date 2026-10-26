import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export function findPython(requested, run = spawnSync) {
  const bundled = path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
  const candidates = requested ? [[requested, []]] : [['py', ['-3.13']], ['py', ['-3.12']], ['python', []], ...(existsSync(bundled) ? [[bundled, []]] : [])];
  for (const [exe, prefix] of candidates) {
    const result = run(exe, [...prefix, '-c', 'import sys,struct,json;print(json.dumps({"python":sys.executable,"major":sys.version_info.major,"minor":sys.version_info.minor,"bits":struct.calcsize("P")*8}))'], { windowsHide: true, encoding: 'utf8', timeout: 8000 });
    if (result.status !== 0) continue;
    try {
      const info = JSON.parse(result.stdout.trim());
      if (info.major === 3 && [12, 13].includes(info.minor) && info.bits === 64 && typeof info.python === 'string') return info;
    } catch { /* Try the next interpreter if its output is not usable. */ }
  }
  throw new Error('Install 64-bit Python 3.12 or 3.13 from https://www.python.org/downloads/windows/ and enable its launcher. Then run Setup Camera.cmd again. To select it explicitly: node scripts/setup-camera.js "C:\\Path\\To\\python.exe"');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform !== 'win32') throw new Error('Camera setup requires Windows. Friends can watch from other operating systems in their browser.');
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Install Node.js 24 or newer from https://nodejs.org/');
    console.log('Chaos Deck camera setup\nFinding a supported 64-bit Python interpreter…');
    const { python, minor } = findPython(process.argv[2] || process.env.CHAOS_DECK_PYTHON);
    console.log(`Using Python 3.${minor}. Installing camera and audio dependencies. The first setup can take several minutes.`);
    const dependencies = path.join(root, '.camera-deps');
    const install = spawnSync(python, ['-m', 'pip', 'install', '--only-binary=:all:', '--target', dependencies, 'SpoutGL==0.1.1', 'Pillow==13.0.0', 'proc-tap==1.1.1', 'sounddevice==0.5.6', 'av==19.0.2', 'numpy==2.5.4', 'scipy==1.18.1'], { stdio: 'inherit', windowsHide: true });
    if (install.status !== 0) throw new Error('Dependency download or installation failed. Check the pip message above and your internet connection, then try again.');
    const verify = spawnSync(python, ['-c', 'import sys;sys.path.insert(0,sys.argv[1]);import SpoutGL,av,PIL,proctap,sounddevice,numpy,scipy', dependencies], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
    if (verify.status !== 0) throw new Error('Dependencies installed but could not load. Close the panel and run Setup Camera.cmd again.');
    writeFileSync(path.join(root, '.camera-runtime.json'), JSON.stringify({ python }, null, 2));
    console.log('\nCamera setup complete.\nNext: open Start Chaos Deck.cmd. In VRChat enable OSC and Camera → Stream → Spout Stream. In the panel, open Settings and select Start stream.');
  } catch (error) { console.error(`\nSetup could not finish: ${error.message}`); process.exitCode = 1; }
}
