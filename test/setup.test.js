import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findPython } from '../scripts/setup-camera.js';
import { releaseManifest } from '../scripts/package-release.js';

test('camera setup skips unsupported and 32-bit Python rather than attempting incompatible wheels', () => {
  const attempts = [];
  const found = findPython(undefined, (exe, args) => {
    attempts.push([exe, ...args]);
    const minor = args.includes('-3.13') ? 13 : 12;
    return { status: 0, stdout: JSON.stringify({ python: 'C:\\Python312\\python.exe', major: 3, minor, bits: minor === 13 ? 32 : 64 }) };
  });
  assert.equal(found.minor, 12); assert.equal(attempts.length, 2);
  assert.throws(() => findPython('chosen-python', () => ({ status: 0, stdout: JSON.stringify({ python: 'chosen-python', major: 3, minor: 14, bits: 64 }) })), /64-bit Python 3.12 or 3.13/);
});

test('release manifest includes source and launchers while excluding personal data and generated artifacts', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deck-release-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  for (const folder of ['data', 'artifacts', '.camera-deps', 'releases', 'public', 'scripts', 'docs']) await mkdir(path.join(directory, folder));
  for (const filename of ['data/chaos-deck.sqlite', '.camera-runtime.json', '.deck-access.json', '.env', 'artifacts/private.png', 'releases/old.zip', 'scripts/.env', 'scripts/private.sqlite', 'public/app.js', 'scripts/setup-camera.js', 'docs/QUICKSTART.md']) await writeFile(path.join(directory, filename), 'fixture');
  const files = (await releaseManifest(directory)).map(file => file.replaceAll('\\', '/'));
  assert.ok(files.includes('Start Chaos Deck.cmd')); assert.ok(files.includes('.gitignore'));
  assert.ok(files.includes('public/app.js')); assert.ok(files.includes('scripts/setup-camera.js')); assert.ok(files.includes('docs/QUICKSTART.md'));
  assert.equal(files.some(file => /(?:sqlite|\.env|private|^data\/|^artifacts\/|^releases\/|^\.camera|^\.deck)/.test(file)), false);
});
