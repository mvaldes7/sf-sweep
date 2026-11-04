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
