#!/usr/bin/env node
// Generate a VAPID key pair locally (free, offline). Prints the PUBLIC key only and writes the
// private key to a file you pipe into `wrangler secret put`. Never commit the private key.
import { webcrypto as c } from "node:crypto";
import { writeFileSync } from "node:fs";
const kp = await c.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const raw = new Uint8Array(await c.subtle.exportKey("raw", kp.publicKey));
const jwk = await c.subtle.exportKey("jwk", kp.privateKey);
const b64u = (b) => Buffer.from(b).toString("base64url");
const out = process.argv[2] || ".vapid-private.key";
writeFileSync(out, jwk.d, { mode: 0o600 });
console.log(`VAPID public key (safe to share, set as VITE_VAPID_PUBLIC_KEY and VAPID_PUBLIC_KEY):\n${b64u(raw)}`);
console.log(`Private key written to ${out} (mode 600). Run: npx wrangler secret put VAPID_PRIVATE_KEY < ${out} && rm ${out}`);
