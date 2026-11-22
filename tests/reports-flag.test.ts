import { describe, expect, it } from "vitest";
import { config } from "../src/config";
import { reportsEnabled } from "../src/lib/report-ui";

describe("photo reports feature flag", () => {
  it("is off by default so the Report a sign button stays hidden", () => {
    expect(config.photoReports).toBe(false);
    expect(reportsEnabled()).toBe(false);
  });
});
