import { mkdtemp, mkdir, readdir, copyFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const run = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const rootFiles = ['package.json', '.gitignore', 'server.js', 'README.md', 'Start Chaos Deck.cmd', 'Setup Camera.cmd', 'Reset Admin Password.cmd'];
const folders = { lib: ['.js'], public: ['.html', '.css', '.js'], scripts: ['.js', '.py'], test: ['.js'], docs: ['.md'] };

export async function releaseManifest(directory = root) {
  const files = [...rootFiles];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && /^LICENSE(?:\.[a-z]+)?$/i.test(entry.name)) files.push(entry.name);
  }
  async function visit(relative, extensions) {
    let entries;
    try { entries = await readdir(path.join(directory, relative), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === '__pycache__') continue;
      if (entry.isSymbolicLink()) throw new Error(`Release source must not contain symbolic links: ${relative}/${entry.name}`);
      const filename = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(filename, extensions);
      else if (entry.isFile() && extensions.includes(path.extname(entry.name))) files.push(filename);
    }
  }
  for (const [folder, extensions] of Object.entries(folders)) await visit(folder, extensions);
  return files.sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let staging;
  try {
    if (process.platform !== 'win32') throw new Error('The ZIP builder currently uses Windows PowerShell. On other systems use npm pack.');
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    if (!/^[a-z0-9-]+$/.test(pkg.name) || !/^[0-9A-Za-z.-]+$/.test(pkg.version)) throw new Error('Invalid release name or version.');
    const files = await releaseManifest();
    staging = await mkdtemp(path.join(os.tmpdir(), 'chaos-deck-release-'));
    for (const filename of files) {
      const target = path.join(staging, filename);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(root, filename), target);
    }
    const outputDirectory = path.join(root, 'releases');
    await mkdir(outputDirectory, { recursive: true });
    const output = path.join(outputDirectory, `${pkg.name}-${pkg.version}.zip`);
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    const command = `$ErrorActionPreference='Stop'; $files=@(Get-ChildItem -LiteralPath ${quote(staging)} -Force | Select-Object -ExpandProperty FullName); Compress-Archive -LiteralPath $files -DestinationPath ${quote(output)} -Force`;
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 60000 });
    console.log(`Release ZIP ready: ${output}\n${files.length} source files included. Accounts, chat history, local configuration, dependencies, logs and screenshots are excluded.`);
    if (!files.some(file => /^LICENSE(?:\.|$)/i.test(file))) console.log('Before publishing: choose a project license and add its LICENSE file.');
  } catch (error) { console.error(`Release packaging failed: ${error.message}`); process.exitCode = 1; }
  finally {
    if (staging) {
      const target = path.resolve(staging), parent = path.resolve(os.tmpdir());
      if (path.dirname(target) !== parent || !path.basename(target).startsWith('chaos-deck-release-')) throw new Error('Refusing to clean an unexpected staging path.');
      await rm(target, { recursive: true, force: true });
    }
  }
}
