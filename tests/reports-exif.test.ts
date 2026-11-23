import { describe, expect, it } from "vitest";
import { detectKind, isHeic, stripExif, HEIC_PHOTO_ERROR, MAX_PHOTO_BYTES } from "../workers/reports/src/exif";

function u16be(n: number): number[] { return [(n >> 8) & 0xff, n & 0xff]; }

/** Minimal JPEG: SOI, APP0 JFIF, APP1 EXIF, SOS+payload, EOI. */
function jpegWithExif(): Uint8Array {
  const app0 = [0xff, 0xe0, ...u16be(16), 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const exif = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x47, 0x50, 0x53]; // "Exif\0\0GPS"
  const app1 = [0xff, 0xe1, ...u16be(2 + exif.length), ...exif];
  // SOS with a 2-byte length then one scan byte and EOI
  const sos = [0xff, 0xda, ...u16be(2), 0x00, 0xff, 0xd9];
  return Uint8Array.from([0xff, 0xd8, ...app0, ...app1, ...sos]);
}

function pngWithText(): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const chunk = (type: string, data: number[]) => {
    const len = data.length;
    const head = [(len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff, ...[...type].map((c) => c.charCodeAt(0)), ...data];
    const crc = [0, 0, 0, 0];
    return [...head, ...crc];
  };
  const ihdr = chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]);
  const text = chunk("tEXt", [..."Comment\0secret location"].map((c) => c.charCodeAt(0)));
  const idat = chunk("IDAT", [0]);
  const iend = chunk("IEND", []);
  return Uint8Array.from([...sig, ...ihdr, ...text, ...idat, ...iend]);
}

function webpWithExif(): Uint8Array {
  const chunk = (fourcc: string, data: number[]) => {
    const size = data.length;
    const pad = size % 2 ? [0] : [];
    const sizeB = [size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >> 24) & 0xff];
    return [...fourcc].map((c) => c.charCodeAt(0)).concat(sizeB, data, pad);
  };
  // VP8X flags: set EXIF bit (bit 3)
  const vp8x = chunk("VP8X", [0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const exif = chunk("EXIF", [..."Exif\0\0GPS"].map((c) => c.charCodeAt(0)));
  const vp8 = chunk("VP8 ", [0x00]);
  const body = [...vp8x, ...exif, ...vp8];
  const riffSize = 4 + body.length;
  return Uint8Array.from([
    0x52, 0x49, 0x46, 0x46,
    riffSize & 0xff, (riffSize >> 8) & 0xff, (riffSize >> 16) & 0xff, (riffSize >> 24) & 0xff,
    0x57, 0x45, 0x42, 0x50,
    ...body,
  ]);
}

describe("stripExif", () => {
  it("removes the JPEG APP1 EXIF segment and keeps JFIF + image data", () => {
    const raw = jpegWithExif();
    expect(detectKind(raw)).toBe("jpeg");
    expect(new TextDecoder().decode(raw)).toContain("GPS");
    const { bytes, kind } = stripExif(raw);
    expect(kind).toBe("jpeg");
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain("Exif");
    expect(text).not.toContain("GPS");
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
    expect(bytes[bytes.length - 2]).toBe(0xff);
    expect(bytes[bytes.length - 1]).toBe(0xd9);
  });

  it("drops PNG tEXt metadata and keeps IHDR/IDAT/IEND", () => {
    const raw = pngWithText();
    expect(new TextDecoder().decode(raw)).toContain("secret location");
    const { bytes, kind } = stripExif(raw);
    expect(kind).toBe("png");
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain("secret location");
    expect(text).toContain("IHDR");
    expect(text).toContain("IEND");
  });

  it("removes a WebP EXIF chunk and clears the VP8X EXIF flag", () => {
    const raw = webpWithExif();
    expect(detectKind(raw)).toBe("webp");
    expect(new TextDecoder().decode(raw)).toContain("GPS");
    const { bytes, kind } = stripExif(raw);
    expect(kind).toBe("webp");
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain("EXIF");
    expect(text).not.toContain("GPS");
    expect(text).toContain("VP8X");
  });

  it("rejects empty, oversized, and unknown buffers", () => {
    expect(() => stripExif(new Uint8Array())).toThrow(/empty/);
    expect(() => stripExif(new Uint8Array(MAX_PHOTO_BYTES + 1).fill(0xff))).toThrow(/too large/);
    expect(() => stripExif(new Uint8Array([1, 2, 3, 4]))).toThrow(/unsupported/);
  });
});

function hasMarker(buf: Uint8Array, marker: number): boolean {
  for (let i = 0; i < buf.length - 1; i++) if (buf[i] === 0xff && buf[i + 1] === marker) return true;
  return false;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function heicBytes(): Uint8Array {
  // ISO BMFF: size + 'ftyp' + 'heic' brand
  return Uint8Array.from([
    0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
    0, 0, 0, 0, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0,
  ]);
}

describe("stripJpeg trailers and later scans", () => {
  it("drops GPS/APP1 from a GPS JPEG that has another GPS JPEG appended, and nothing after EOI", () => {
    const first = jpegWithExif();
    const raw = concat(first, first);
    expect(new TextDecoder().decode(raw)).toContain("GPS");
    const { bytes, kind } = stripExif(raw);
    expect(kind).toBe("jpeg");
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain("GPS");
    expect(text).not.toContain("Exif");
    expect(hasMarker(bytes, 0xe1)).toBe(false);
    expect(bytes[bytes.length - 2]).toBe(0xff);
    expect(bytes[bytes.length - 1]).toBe(0xd9);
    expect(bytes).toEqual(stripExif(first).bytes);
  });

  it("drops APPn between progressive SOS scans", () => {
    const app0 = [0xff, 0xe0, ...u16be(16), 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
    const exif = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x47, 0x50, 0x53];
    const app1 = [0xff, 0xe1, ...u16be(2 + exif.length), ...exif];
    const sos = [0xff, 0xda, ...u16be(2)];
    const raw = Uint8Array.from([0xff, 0xd8, ...app0, ...sos, 0x11, ...app1, ...sos, 0x22, 0xff, 0xd9]);
    expect(new TextDecoder().decode(raw)).toContain("GPS");
    const { bytes } = stripExif(raw);
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain("GPS");
    expect(text).not.toContain("Exif");
    expect(hasMarker(bytes, 0xe1)).toBe(false);
    expect(hasMarker(bytes, 0xda)).toBe(true);
    expect(bytes[bytes.length - 2]).toBe(0xff);
    expect(bytes[bytes.length - 1]).toBe(0xd9);
    expect([...bytes]).toContain(0x11);
    expect([...bytes]).toContain(0x22);
  });

  it("strips a ~2.3 MB JPEG in well under 10 ms using keep-ranges", () => {
    const app0 = [0xff, 0xe0, ...u16be(16), 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
    const exif = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x47, 0x50, 0x53];
    const app1 = [0xff, 0xe1, ...u16be(2 + exif.length), ...exif];
    const scan = new Uint8Array(2_300_000).fill(0x5a);
    const raw = new Uint8Array(2 + app0.length + app1.length + 4 + scan.length + 2);
    raw[0] = 0xff; raw[1] = 0xd8;
    raw.set(app0, 2);
    raw.set(app1, 2 + app0.length);
    const sosAt = 2 + app0.length + app1.length;
    raw.set([0xff, 0xda, 0x00, 0x02], sosAt);
    raw.set(scan, sosAt + 4);
    raw[raw.length - 2] = 0xff;
    raw[raw.length - 1] = 0xd9;
    stripExif(jpegWithExif()); // warmup
    const t0 = performance.now();
    const { bytes, kind } = stripExif(raw);
    const ms = performance.now() - t0;
    expect(kind).toBe("jpeg");
    expect(bytes.byteLength).toBe(raw.byteLength - app1.length);
    expect(new TextDecoder().decode(bytes.subarray(0, 64))).not.toContain("GPS");
    expect(ms).toBeLessThan(10);
  });
});

describe("HEIC uploads", () => {
  it("rejects a HEIC buffer with a friendly error", () => {
    const raw = heicBytes();
    expect(isHeic(raw)).toBe(true);
    expect(detectKind(raw)).toBeNull();
    expect(() => stripExif(raw)).toThrow(HEIC_PHOTO_ERROR);
  });
});
