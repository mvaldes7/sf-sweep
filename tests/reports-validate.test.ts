import { describe, expect, it } from "vitest";
import { fieldsFromForm, validateSubmit, type SubmitFields } from "../workers/reports/src/validate";

const ok = (): SubmitFields => ({
  cnn: "1642000",
  side: "R",
  street: "30th Ave",
  limits: "Geary Blvd - Anza St",
  blockside: "West",
  lat: 37.78,
  lng: -122.48,
  turnstile: "turnstile-token-ok",
});

describe("validateSubmit", () => {
  it("accepts a photo-only report with a location in SF", () => {
    expect(validateSubmit(ok())).toBeNull();
  });
  it("rejects a missing cnn, bad side, and a location outside SF", () => {
    expect(validateSubmit({ ...ok(), cnn: "" })).toMatch(/cnn/);
    expect(validateSubmit({ ...ok(), side: "X" as SubmitFields["side"] })).toMatch(/side/);
    expect(validateSubmit({ ...ok(), lat: 40 })).toMatch(/outside/);
    expect(validateSubmit({ ...ok(), lng: -100 })).toMatch(/outside/);
  });
  it("accepts optional minute-precision hours and rejects from==to", () => {
    expect(validateSubmit({ ...ok(), days: ["Fri"], from: "07:00", to: "07:30" })).toBeNull();
    expect(validateSubmit({ ...ok(), days: ["Fri"], from: "7:30", to: "08:00" })).toBeNull();
    expect(validateSubmit({ ...ok(), days: ["Fri"], from: "07:00", to: "07:00" })).toMatch(/must differ/);
    expect(validateSubmit({ ...ok(), from: "07:00", to: "07:30" })).toMatch(/together/);
    expect(validateSubmit({ ...ok(), days: ["Fri"], from: "07:70", to: "08:00" })).toMatch(/invalid time/);
  });
  it("accepts a report with no turnstile token when captcha is off", () => {
    expect(validateSubmit({ ...ok(), turnstile: "" })).toBeNull();
    expect(validateSubmit({ ...ok(), turnstile: undefined })).toBeNull();
  });
  it("requires a turnstile token when captcha is on", () => {
    expect(validateSubmit({ ...ok(), turnstile: "" }, { requireTurnstile: true })).toMatch(/turnstile/);
    expect(validateSubmit({ ...ok() }, { requireTurnstile: true })).toBeNull();
  });
  it("reads fields from form data, including a :30 end time", () => {
    const fd = new FormData();
    fd.set("cnn", "1642000");
    fd.set("side", "R");
    fd.set("lat", "37.78");
    fd.set("lng", "-122.48");
    fd.set("from", "07:00");
    fd.set("to", "07:30");
    fd.set("days", JSON.stringify(["Fri"]));
    fd.set("cf-turnstile-response", "turnstile-token-ok");
    const f = fieldsFromForm(fd);
    expect(f.from).toBe("07:00");
    expect(f.to).toBe("07:30");
    expect(f.days).toEqual(["Fri"]);
    expect(validateSubmit(f)).toBeNull();
  });
});
