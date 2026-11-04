// PMTiles v3 directory decoder (varint-encoded), per the spec. pmtiles' own copy is not exported.
function readVarint(p) {
  let v = 0, s = 1, b;
  do { b = p.buf[p.pos++]; v += (b & 0x7f) * s; s *= 128; } while (b & 0x80);
  return v;
}
export function deserializeIndex(ab) {
  const p = { buf: new Uint8Array(ab), pos: 0 };
  const n = readVarint(p);
  const es = [];
  let last = 0;
  for (let i = 0; i < n; i++) { last += readVarint(p); es.push({ tileId: last, offset: 0, length: 0, runLength: 1 }); }
  for (const e of es) e.runLength = readVarint(p);
  for (const e of es) e.length = readVarint(p);
  for (let i = 0; i < n; i++) { const v = readVarint(p); es[i].offset = v === 0 && i > 0 ? es[i - 1].offset + es[i - 1].length : v - 1; }
  return es;
}
