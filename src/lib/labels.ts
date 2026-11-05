/** UI label helpers (pure, tested). */

const COMPASS: Record<string, string> = {
  north: "North", south: "South", east: "East", west: "West",
  northeast: "Northeast", northwest: "Northwest", southeast: "Southeast", southwest: "Southwest",
};

/**
 * Human side label from DataSF "blockside" (e.g. "NorthEast" -> "Northeast side").
 * About 2% of sides have no blockside; those fall back to the CNN-relative side ("Left side (L)").
 */
export function sideLabel(blockside: string | undefined, side: string): string {
  const c = COMPASS[(blockside || "").replace(/[^a-z]/gi, "").toLowerCase()];
  if (c) return `${c} side`;
  return side === "L" ? "Left side (L)" : side === "R" ? "Right side (R)" : "Side unknown";
}

export interface LegendItem { cls: "clear" | "soon" | "now"; text: string }
export function legendItems(mode: "live" | "plan"): LegendItem[] {
  return mode === "plan"
    ? [{ cls: "now", text: "Swept this day" }, { cls: "clear", text: "No sweeping" }]
    : [{ cls: "clear", text: "Clear" }, { cls: "soon", text: "Within 1 hr" }, { cls: "now", text: "Sweeping now" }];
}

export interface AlertEnv { pushSupported: boolean; apiConfigured: boolean; blocked: boolean }
export interface AlertStatus { text: string; kind: "on" | "note" | "error" | "off"; canArm: boolean }
/** What the car card says about push alerts. Saving the car never depends on this. */
export function alertStatus(car: { alert?: boolean; alertError?: string; alertNote?: string }, env: AlertEnv): AlertStatus {
  if (car.alert) return { text: "Alert 1 hr before - push on", kind: "on", canArm: false };
  if (env.blocked || car.alertNote === "blocked")
    return { text: "Car saved. Notifications blocked - use the .ics reminder.", kind: "note", canArm: false };
  if (!env.pushSupported) return { text: "Push needs Home Screen install on iPhone - use the .ics reminder", kind: "note", canArm: false };
  if (!env.apiConfigured) return { text: "Push server not configured - use the .ics reminder", kind: "note", canArm: false };
  if (car.alertError) return { text: `Push alert could not be set (${car.alertError}). Your car is still saved.`, kind: "error", canArm: true };
  return { text: "Push alert off", kind: "off", canArm: true };
}
