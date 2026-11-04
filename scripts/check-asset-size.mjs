// Fails if any file in the given directories exceeds the Cloudflare Pages per-file limit (25 MiB).
import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export const PAGES_MAX_FILE_BYTES = 25 * 1024 * 1024;

export async function oversized(dir, max = PAGES_MAX_FILE_BYTES) {
  const out = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await oversized(p, max)));
    else if (e.isFile()) { const s = await stat(p); if (s.size > max) out.push({ path: p, size: s.size }); }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dirs = process.argv.slice(2).length ? process.argv.slice(2) : ["public/data", "dist"];
  const bad = (await Promise.all(dirs.map((d) => oversized(d)))).flat();
  for (const b of bad) console.error(`too large for Cloudflare Pages (25 MiB): ${b.path} ${b.size} bytes`);
  if (bad.length) process.exit(1);
}

// Small fs helpers for tests (keeps node: imports out of the browser-typed test project).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
export function makeTempFiles(files) {
  const d = mkdtempSync(join(tmpdir(), "sz-"));
  for (const [name, size] of Object.entries(files)) { const p = join(d, name); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, ""); truncateSync(p, size); }
  return d;
}
export function readJsonIfExists(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}
