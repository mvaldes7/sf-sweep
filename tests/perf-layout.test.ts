import html from "../index.html?raw";
import { describe, expect, it } from "vitest";
import { buildMarks } from "../src/lib/marks";
import { cssPx, trackHeight, type ROCtor } from "../src/lib/layout";

describe("buildMarks", () => {
  it("maps numeric state to icon status", () => {
    const fc = buildMarks([{ id: 1, mid: [0, 0] }, { id: 2, mid: [1, 1] }, { id: 3, mid: [2, 2] }], new Map([[1, 2], [2, 1]]));
    expect(fc.features.map((f) => f.properties!.st)).toEqual(["now", "soon", "clear"]);
  });
});

describe("car height tracking", () => {
  it("rounds up and clamps", () => { expect(cssPx(63.2)).toBe("64px"); expect(cssPx(-3)).toBe("0px"); });
  it("updates the CSS variable when the bar resizes or hides", () => {
    let h = 80; let cb = () => {};
    const el = { hidden: false, getBoundingClientRect: () => ({ height: h }) } as unknown as HTMLElement;
    const set: Record<string, string> = {};
    const root = { style: { setProperty: (k: string, v: string) => { set[k] = v; } } };
    const RO = class { constructor(c: () => void) { cb = c; } observe() {} disconnect() {} } as unknown as ROCtor;
    trackHeight(el, root, "--car-h", RO);
    expect(set["--car-h"]).toBe("80px");
    h = 131.5; cb(); expect(set["--car-h"]).toBe("132px");
    (el as { hidden: boolean }).hidden = true; cb(); expect(set["--car-h"]).toBe("0px");
  });
});

describe("attribution footer", () => {
  it("credits OSM, Protomaps and DataSF in the always-visible footer", () => {
    const footer = html.slice(html.indexOf('<footer class="attrib"'), html.indexOf("</footer>"));
    for (const s of ["OpenStreetMap", "Protomaps", "DataSF"]) expect(footer).toContain(s);
  });
});
