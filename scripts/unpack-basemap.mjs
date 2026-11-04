// Unpack a PMTiles archive into static z/x/y.mvt files (uncompressed MVT) so Cloudflare Pages can serve the basemap.
// Pages does not answer HTTP Range requests with 206, which PMTiles needs; plain tile files need no range support.
// Usage: node scripts/unpack-basemap.mjs public/data/sf-basemap.pmtiles public/data/basemap
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { PMTiles, tileIdToZxy } from "pmtiles";

const [src = "public/data/sf-basemap.pmtiles", out = "public/data/basemap"] = process.argv.slice(2);
const fh = await open(src, "r");
const source = {
  getKey: () => src,
  async getBytes(offset, length) {
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, offset);
    return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + length) };
  },
};
const decompress = async (b, c) => (c === 2 ? new Uint8Array(gunzipSync(Buffer.from(b))).buffer : b);
const pm = new PMTiles(source, undefined, decompress);
const h = await pm.getHeader();
await rm(out, { recursive: true, force: true });
let n = 0;
async function walk(offset, length) {
  const { data } = await source.getBytes(offset, length);
  const { deserializeIndex } = await import("./pmtiles-index.mjs");
  for (const e of deserializeIndex(await decompress(data, h.internalCompression))) {
    if (e.runLength === 0) { await walk(h.leafDirectoryOffset + e.offset, e.length); continue; }
    const tile = await source.getBytes(h.tileDataOffset + e.offset, e.length);
    const body = Buffer.from(await decompress(tile.data, h.tileCompression));
    for (let i = 0; i < e.runLength; i++) {
      const [z, x, y] = tileIdToZxy(e.tileId + i);
      await mkdir(join(out, `${z}`, `${x}`), { recursive: true });
      await writeFile(join(out, `${z}`, `${x}`, `${y}.mvt`), body);
      n++;
    }
  }
}
await walk(h.rootDirectoryOffset, h.rootDirectoryLength);
await fh.close();
await writeFile(join(out, "meta.json"), JSON.stringify({ minzoom: h.minZoom, maxzoom: h.maxZoom, bounds: [h.minLon, h.minLat, h.maxLon, h.maxLat], tiles: n }));
console.log(`wrote ${n} tiles to ${out} (z${h.minZoom}-${h.maxZoom})`);
