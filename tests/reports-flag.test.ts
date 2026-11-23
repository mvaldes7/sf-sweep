import { describe, expect, it } from "vitest";
import { config } from "../src/config";
import { HEIC_UPLOAD_ERROR, PHOTO_ACCEPT, isHeicUpload, reportTurnstileSlot, reportsEnabled, turnstileEnabled } from "../src/lib/report-ui";

describe("photo reports feature flag", () => {
  it("is off by default so the Report a sign button stays hidden", () => {
    expect(config.photoReports).toBe(false);
    expect(reportsEnabled()).toBe(false);
  });

  it("is enabled by the flag and API base even without a Turnstile site key", () => {
    expect(reportsEnabled({ photoReports: true, reportsApiBase: "https://sf-sweep-reports.example" })).toBe(true);
    expect(reportsEnabled({ photoReports: true, reportsApiBase: "" })).toBe(false);
    expect(reportsEnabled({ photoReports: false, reportsApiBase: "https://sf-sweep-reports.example" })).toBe(false);
  });
});

describe("Turnstile widget (optional, off in v1)", () => {
  it("does not render or enable the widget when no site key is set", () => {
    expect(turnstileEnabled("")).toBe(false);
    expect(reportTurnstileSlot("")).toBe("");
    expect(turnstileEnabled("site-key")).toBe(true);
    expect(reportTurnstileSlot("site-key")).toBe('<div id="report-turnstile"></div>');
  });
});

describe("photo file types", () => {
  it("accepts JPEG, PNG and WebP only, so iOS converts HEIC on upload", () => {
    expect(PHOTO_ACCEPT).toBe("image/jpeg,image/png,image/webp");
    expect(PHOTO_ACCEPT).not.toContain("image/*");
    expect(PHOTO_ACCEPT).not.toMatch(/heic/i);
  });

  it("returns a friendly error when a HEIC file still arrives", () => {
    expect(isHeicUpload(new File([new Uint8Array([1])], "sign.HEIC", { type: "image/heic" }))).toBe(true);
    expect(isHeicUpload(new File([new Uint8Array([1])], "sign.heif", { type: "" }))).toBe(true);
    expect(isHeicUpload(new File([new Uint8Array([1])], "sign.jpg", { type: "image/jpeg" }))).toBe(false);
    expect(HEIC_UPLOAD_ERROR).toMatch(/HEIC/);
    expect(HEIC_UPLOAD_ERROR).toMatch(/JPEG/);
  });
});
