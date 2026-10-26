import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const defaultAvatarRoot = path.join(os.homedir(), 'AppData', 'LocalLow', 'VRChat', 'VRChat', 'OSC');

export async function discoverAvatars(root = defaultAvatarRoot) {
  const avatars = [];
  let accounts;
  try { accounts = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  for (const account of accounts.filter(entry => entry.isDirectory() && entry.name.startsWith('usr_'))) {
    const folder = path.join(root, account.name, 'Avatars');
    let files;
    try { files = await readdir(folder); } catch { continue; }
    for (const file of files.filter(name => /^avtr_[\w-]+\.json$/.test(name)).slice(0, 500)) {
      try {
        const filename = path.join(folder, file);
        const info = await stat(filename);
        if (info.size > 2_000_000) continue;
        // Unity/.NET writes these JSON files with a UTF-8 byte order mark on Windows.
        const config = JSON.parse((await readFile(filename, 'utf8')).replace(/^\uFEFF/, ''));
        const parameters = (Array.isArray(config.parameters) ? config.parameters : []).flatMap(p => {
          if (!p || typeof p !== 'object') return [];
          const input = p.input;
          const type = { int: 'Int', float: 'Float', bool: 'Bool' }[String(input?.type).toLowerCase()];
          if (!type || typeof p.name !== 'string' || !input.address?.startsWith('/avatar/parameters/')) return [];
          return [{ name: p.name, address: input.address, outputAddress: p.output?.address, type }];
        });
        avatars.push({ id: file.slice(0, -5), name: String(config.name || 'Unnamed avatar'), parameters, modified: info.mtimeMs });
      } catch { /* A partial or malformed config must not prevent other avatars loading. */ }
    }
  }
  return avatars.sort((a, b) => b.modified - a.modified).filter((avatar, index, all) => all.findIndex(a => a.id === avatar.id) === index);
}
