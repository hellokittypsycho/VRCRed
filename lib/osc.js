// OSC 1.0 messages and bundles. No native modules or external dependencies.
function string(value) {
  const bytes = Buffer.from(value, 'utf8');
  const result = Buffer.alloc(Math.ceil((bytes.length + 1) / 4) * 4);
  bytes.copy(result);
  return result;
}

export function encodeMessage(address, type, value) {
  return encodeArguments(address, [{ type, value }]);
}

export function encodeArguments(address, args) {
  if (!address.startsWith('/') || address.includes('\0')) throw new Error('Invalid OSC address');
  const tags = [], values = [];
  for (const { type, value } of args) {
    const tag = { Int: 'i', Float: 'f', Bool: value ? 'T' : 'F', String: 's' }[type];
    if (!tag) throw new Error('Unsupported OSC type');
    tags.push(tag);
    if (tag === 'i' || tag === 'f') {
      const data = Buffer.alloc(4);
      if (tag === 'i') data.writeInt32BE(value);
      else data.writeFloatBE(value);
      values.push(data);
    } else if (tag === 's') values.push(string(value));
  }
  return Buffer.concat([string(address), string(`,${tags.join('')}`), ...values]);
}

export function decodePacket(packet, depth = 0) {
  if (!Buffer.isBuffer(packet) || packet.length > 65535 || depth > 8) throw new Error('Invalid OSC packet');
  if (packet.subarray(0, 8).equals(Buffer.from('#bundle\0'))) {
    if (packet.length < 16) throw new Error('Truncated OSC bundle');
    const messages = [];
    let offset = 16;
    while (offset < packet.length) {
      if (offset + 4 > packet.length) throw new Error('Truncated OSC bundle size');
      const size = packet.readInt32BE(offset);
      offset += 4;
      if (size <= 0 || offset + size > packet.length) throw new Error('Invalid OSC bundle size');
      messages.push(...decodePacket(packet.subarray(offset, offset + size), depth + 1));
      offset += size;
    }
    return messages;
  }
  let offset = 0;
  function readString() {
    const end = packet.indexOf(0, offset);
    if (end < 0) throw new Error('Unterminated OSC string');
    const result = packet.toString('utf8', offset, end);
    offset = Math.ceil((end + 1) / 4) * 4;
    if (offset > packet.length) throw new Error('Invalid OSC padding');
    return result;
  }
  const address = readString();
  const tags = readString();
  if (!address.startsWith('/') || !tags.startsWith(',')) throw new Error('Invalid OSC message');
  const args = [];
  for (const tag of tags.slice(1)) {
    if (tag === 'T' || tag === 'F') args.push(tag === 'T');
    else if (tag === 's') args.push(readString());
    else if (tag === 'i' || tag === 'f') {
      if (offset + 4 > packet.length) throw new Error('Truncated OSC argument');
      args.push(tag === 'i' ? packet.readInt32BE(offset) : packet.readFloatBE(offset));
      offset += 4;
    } else throw new Error(`Unsupported OSC tag: ${tag}`);
  }
  return [{ address, args }];
}
