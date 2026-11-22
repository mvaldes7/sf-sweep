/** Server-side EXIF / metadata stripping for JPEG, PNG and WebP. Pure; no I/O. */
export const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
export type PhotoKind = "jpeg" | "png" | "webp";

export function detectKind(buf: Uint8Array): PhotoKind | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return "png";
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "webp";
  return null;
}

export function mimeFor(kind: PhotoKind): string {
  return kind === "jpeg" ? "image/jpeg" : kind === "png" ? "image/png" : "image/webp";
}

export function extFor(kind: PhotoKind): string {
  return kind === "jpeg" ? "jpg" : kind;
}

/** Strip EXIF, XMP, IPTC and text metadata. Throws if the buffer is not a supported image or is too large. */
export function stripExif(buf: Uint8Array): { bytes: Uint8Array; kind: PhotoKind } {
  if (buf.byteLength === 0) throw new Error("empty photo");
  if (buf.byteLength > MAX_PHOTO_BYTES) throw new Error("photo too large");
  const kind = detectKind(buf);
  if (!kind) throw new Error("unsupported image type");
  if (kind === "jpeg") return { bytes: stripJpeg(buf), kind };
  if (kind === "png") return { bytes: stripPng(buf), kind };
  return { bytes: stripWebp(buf), kind };
}

function u16be(b: Uint8Array, i: number): number { return (b[i] << 8) | b[i + 1]; }
function u32be(b: Uint8Array, i: number): number { return (b[i] * 0x1000000 + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]) >>> 0; }
function u32le(b: Uint8Array, i: number): number { return (b[i] + (b[i + 1] << 8) + (b[i + 2] << 16) + b[i + 3] * 0x1000000) >>> 0; }

/** Drop APP1-APP15 (EXIF/XMP/IPTC) and COM comments. Keep APP0 (JFIF) and the image payload. */
function stripJpeg(buf: Uint8Array): Uint8Array {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error("invalid jpeg");
  const out: number[] = [0xff, 0xd8];
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw new Error("invalid jpeg");
    let j = i;
    while (j < buf.length && buf[j] === 0xff) j++;
    if (j >= buf.length) throw new Error("invalid jpeg");
    const marker = buf[j];
    i = j + 1;
    if (marker === 0xd9) { out.push(0xff, 0xd9); break; } // EOI
    if (marker === 0xda) { // SOS: copy the rest (entropy-coded data + EOI)
      out.push(0xff, 0xda);
      for (let k = i; k < buf.length; k++) out.push(buf[k]);
      break;
    }
    if (marker === 0xd8) throw new Error("invalid jpeg");
    // standalone markers (RST, SOI already handled) have no length
    if (marker >= 0xd0 && marker <= 0xd7) { out.push(0xff, marker); continue; }
    if (i + 1 >= buf.length) throw new Error("invalid jpeg");
    const len = u16be(buf, i);
    if (len < 2 || i + len > buf.length) throw new Error("invalid jpeg");
    const drop = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!drop) {
      out.push(0xff, marker);
      for (let k = 0; k < len; k++) out.push(buf[i + k]);
    }
    i += len;
  }
  return Uint8Array.from(out);
}

const PNG_DROP = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);

function stripPng(buf: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [buf.slice(0, 8)];
  let i = 8;
  let seenIend = false;
  while (i + 12 <= buf.length) {
    const len = u32be(buf, i);
    const type = String.fromCharCode(buf[i + 4], buf[i + 5], buf[i + 6], buf[i + 7]);
    const end = i + 12 + len;
    if (end > buf.length) throw new Error("invalid png");
    if (!PNG_DROP.has(type)) parts.push(buf.slice(i, end));
    i = end;
    if (type === "IEND") { seenIend = true; break; }
  }
  if (!seenIend) throw new Error("invalid png");
  return concat(parts);
}

function stripWebp(buf: Uint8Array): Uint8Array {
  if (u32le(buf, 4) + 8 !== buf.length && u32le(buf, 4) + 8 !== buf.length + (buf.length % 2)) {
    // Some writers pad; still parse chunks from offset 12.
  }
  const keep: { fourcc: string; payload: Uint8Array }[] = [];
  let i = 12;
  while (i + 8 <= buf.length) {
    const fourcc = String.fromCharCode(buf[i], buf[i + 1], buf[i + 2], buf[i + 3]);
    const size = u32le(buf, i + 4);
    const start = i + 8;
    const end = start + size;
    if (end > buf.length) throw new Error("invalid webp");
    if (fourcc !== "EXIF" && fourcc !== "XMP ") keep.push({ fourcc, payload: buf.slice(start, end) });
    i = end + (size % 2); // pad to even
  }
  for (const c of keep) {
    if (c.fourcc === "VP8X" && c.payload.length >= 4) {
      // Clear EXIF (bit 3) and XMP (bit 4) flags in the first flags byte.
      const p = new Uint8Array(c.payload);
      p[0] = p[0] & ~(1 << 3) & ~(1 << 4);
      c.payload = p;
    }
  }
  const chunks: Uint8Array[] = [];
  for (const c of keep) {
    const size = c.payload.length;
    const head = new Uint8Array(8);
    for (let k = 0; k < 4; k++) head[k] = c.fourcc.charCodeAt(k);
    head[4] = size & 0xff; head[5] = (size >> 8) & 0xff; head[6] = (size >> 16) & 0xff; head[7] = (size >> 24) & 0xff;
    chunks.push(head, c.payload);
    if (size % 2) chunks.push(new Uint8Array([0]));
  }
  const body = concat(chunks);
  const out = new Uint8Array(12 + body.length);
  out.set([0x52, 0x49, 0x46, 0x46], 0);
  const riffSize = 4 + body.length;
  out[4] = riffSize & 0xff; out[5] = (riffSize >> 8) & 0xff; out[6] = (riffSize >> 16) & 0xff; out[7] = (riffSize >> 24) & 0xff;
  out.set([0x57, 0x45, 0x42, 0x50], 8);
  out.set(body, 12);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
