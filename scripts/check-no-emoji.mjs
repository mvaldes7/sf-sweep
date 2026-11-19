#!/usr/bin/env node
// Fails if any tracked text file contains emoji / pictographic characters.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
const files = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter((f) => f && !/\.(png|jpg|ico|pmtiles|pbf|gz)$/.test(f) && f !== "pnpm-lock.yaml");
const re = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|\uFE0F/u;
let bad = 0;
for (const f of files) {
  let t; try { t = readFileSync(f, "utf8"); } catch { continue; }
  t.split("\n").forEach((line, i) => { if (re.test(line)) { console.error(`${f}:${i + 1}: emoji-like character`); bad++; } });
}
if (bad) process.exit(1);
console.log(`no-emoji check passed (${files.length} files)`);
