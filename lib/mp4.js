// Keep only an initialization segment and the latest complete keyframe fragment.
// Every client receives the same encode; slow clients reconnect instead of growing a queue.
export class Mp4Relay {
  constructor() { this.reset(); }
  reset() {
    this.pending = Buffer.alloc(0); this.header = []; this.init = null;
    this.fragment = []; this.latest = null; this.fragments = 0;
  }
  push(chunk, publish) {
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= 8) {
      const size = this.pending.readUInt32BE(0), type = this.pending.toString('ascii', 4, 8);
      if (size < 8 || size > 16_000_000) throw new Error('Invalid MP4 segment');
      if (this.pending.length < size) break;
      const box = this.pending.subarray(0, size); this.pending = this.pending.subarray(size);
      if (type === 'ftyp' || type === 'moov') {
        this.header.push(box);
        if (type === 'moov') this.init = Buffer.concat(this.header);
      } else if (type === 'moof') this.fragment = [box];
      else if (type === 'mdat' && this.fragment.length) {
        this.fragment.push(box); this.latest = Buffer.concat(this.fragment); this.fragment = [];
        this.fragments++; publish(this.latest);
      }
    }
  }
}
