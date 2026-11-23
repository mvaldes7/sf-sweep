#!/usr/bin/env node
/**
 * Boot the reports Worker in workerd locally (no Cloudflare credentials or
 * remote bindings) and check GET /api/health. Used by CI.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";

const port = Number(process.env.REPORTS_BOOT_PORT || 8789);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cwd = path.join(root, "workers/reports");

const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(CLOUDFLARE_|CF_API_|CF_TOKEN)/.test(key)) delete env[key];
}
env.WRANGLER_SEND_METRICS = "false";
env.CI = "1";

const child = spawn(
  "npx",
  ["-y", "wrangler@4", "dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "-c", "wrangler.boot.toml"],
  { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true },
);

let output = "";
const append = (buf) => {
  output += buf.toString();
};
child.stdout.on("data", append);
child.stderr.on("data", append);

function killTree() {
  if (child.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
  }
}

async function forceKill() {
  if (!child.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
}

process.on("exit", forceKill);
process.on("SIGINT", () => { killTree(); process.exit(1); });
process.on("SIGTERM", () => { killTree(); process.exit(1); });

const deadline = Date.now() + 120_000;
let ok = false;
let lastErr = "not started";
try {
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      lastErr = `wrangler exited with ${child.exitCode}\n${output.slice(-4000)}`;
      break;
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.status === 200) {
        const body = await res.json();
        if (body && body.ok === true && body.service === "sf-sweep-reports") {
          ok = true;
          break;
        }
        lastErr = `unexpected body ${JSON.stringify(body)}`;
      } else {
        lastErr = `status ${res.status}`;
      }
    } catch (e) {
      lastErr = String(e && e.message ? e.message : e);
    }
    await sleep(400);
  }
} finally {
  killTree();
  await sleep(400);
  forceKill();
}

if (!ok) {
  console.error("reports Worker boot check failed:", lastErr);
  if (output) console.error(output.slice(-4000));
  process.exit(1);
}
console.log("reports Worker boot check passed on port", port);
