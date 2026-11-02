import { describe, expect, it } from "vitest";
import { b64urlDecode, b64urlEncode, validate } from "../worker/src/index";

const good = () => ({
  subscription: { endpoint: "https://web.push.apple.com/abc" },
  spot: { cnn: "1579000", side: "R", lat: 37.78, lng: -122.48 },
  fireAt: Date.now() + 3600000,
});

describe("worker validation", () => {
  it("accepts a valid spot", () => expect(validate(good())).toBeNull());
  it("rejects outside SF, bad side, and far-future fire times", () => {
    expect(validate({ ...good(), spot: { ...good().spot, lat: 40 } })).toMatch(/outside/);
    expect(validate({ ...good(), spot: { ...good().spot, side: "X" } })).toMatch(/side/);
    expect(validate({ ...good(), fireAt: Date.now() + 200 * 86400000 })).toMatch(/fireAt/);
    expect(validate({ ...good(), subscription: { endpoint: "http://x" } })).toMatch(/endpoint/);
  });
  it("base64url round trip", () => {
    const b = new Uint8Array([0, 255, 62, 63, 1, 2, 3]);
    expect(Array.from(b64urlDecode(b64urlEncode(b)))).toEqual(Array.from(b));
  });
});
