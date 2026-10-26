import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function read(port, endpoint) {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, { signal: AbortSignal.timeout(1200) });
  if (!response.ok) throw new Error(`OSCQuery returned ${response.status}`);
  const body = await response.text();
  if (body.length > 4_000_000) throw new Error('OSCQuery response too large');
  return JSON.parse(body);
}

export async function findOscQuery() {
  if (process.platform !== 'win32') return null;
  try {
    // Read only the listening TCP ports owned by the running VRChat process.
    const script = '$vrcIds = @(Get-Process VRChat -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id); if ($vrcIds.Count) { @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $vrcIds -contains $_.OwningProcess } | Select-Object -ExpandProperty LocalPort -Unique) | ConvertTo-Json -Compress }';
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 6000 });
    const ports = JSON.parse(stdout || '[]');
    for (const port of [ports].flat().slice(0, 12)) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
      try {
        const info = await read(port, '/?HOST_INFO');
        if (String(info.NAME).startsWith('VRChat-Client') && info.OSC_TRANSPORT === 'UDP') return { port, oscPort: info.OSC_PORT };
      } catch { /* Not an OSCQuery listener. */ }
    }
  } catch { /* Sending OSC still works without discovery. */ }
  return null;
}

export async function readOscQueryValue(port, address) {
  const node = await read(port, address.split('/').map(encodeURIComponent).join('/'));
  return node.VALUE?.[0];
}

export async function readOscQueryValues(port) {
  const tree = await read(port, '/avatar/parameters');
  const values = new Map();
  function visit(node, depth = 0) {
    if (!node || depth > 30 || values.size >= 2000) return;
    if (typeof node.FULL_PATH === 'string' && Array.isArray(node.VALUE) && node.VALUE.length) values.set(node.FULL_PATH, node.VALUE[0]);
    for (const child of Object.values(node.CONTENTS || {})) visit(child, depth + 1);
  }
  visit(tree);
  return values;
}
