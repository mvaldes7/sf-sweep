import { describe, expect, it } from "vitest";
import { config } from "../src/config";
import { reportTurnstileSlot, reportsEnabled, turnstileEnabled } from "../src/lib/report-ui";

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
