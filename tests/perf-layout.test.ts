import html from "../index.html?raw";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildMarks } from "../src/lib/marks";
import { bindMapViewport, cssPx, trackHeight, type EventTargetLike, type ROCtor } from "../src/lib/layout";

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

describe("map viewport binding", () => {
  function target() {
    const listeners: Record<string, (() => void)[]> = {};
    const el: EventTargetLike = {
      addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
      removeEventListener(type, fn) { listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn); },
    };
    return { el, listeners, fire: (type: string) => { for (const f of listeners[type] ?? []) f(); } };
  }

  it("resizes when the container, visualViewport, orientation or pageshow change", () => {
    let calls = 0;
    const map = { resize: () => { calls++; } };
    const container = {} as Element;
    let roCb = () => {};
    let observed: Element | undefined;
    let disconnected = 0;
    const RO = class {
      constructor(c: () => void) { roCb = c; }
      observe(el: Element) { observed = el; }
      disconnect() { disconnected++; }
    } as unknown as ROCtor;
    const vv = target();
    const win = target();
    const queued: (() => void)[] = [];
    const stop = bindMapViewport(map, container, {
      RO, visualViewport: vv.el, win: win.el, raf: (cb) => { queued.push(cb); },
    });
    expect(observed).toBe(container);
    expect(calls).toBe(0);
    queued.shift()!();
    expect(calls).toBe(1);

    roCb(); queued.shift()!();
    expect(calls).toBe(2);

    vv.fire("resize");
    while (queued.length) queued.shift()!();
    expect(calls).toBe(4); // late schedules a second frame

    const afterVv = calls;
    vv.fire("scroll"); queued.shift()!();
    expect(calls).toBe(afterVv + 1);

    const afterScroll = calls;
    win.fire("orientationchange");
    while (queued.length) queued.shift()!();
    expect(calls).toBe(afterScroll + 2);

    const afterOrient = calls;
    win.fire("pageshow");
    while (queued.length) queued.shift()!();
    expect(calls).toBe(afterOrient + 2);

    stop();
    expect(disconnected).toBe(1);
    expect(vv.listeners.resize ?? []).toEqual([]);
    expect(vv.listeners.scroll ?? []).toEqual([]);
    expect(win.listeners.orientationchange ?? []).toEqual([]);
    expect(win.listeners.pageshow ?? []).toEqual([]);
    const afterStop = queued.length;
    vv.fire("resize");
    win.fire("pageshow");
    expect(queued.length).toBe(afterStop);
  });

  it("coalesces resize bursts into one rAF callback", () => {
    let calls = 0;
    const map = { resize: () => { calls++; } };
    let roCb = () => {};
    const RO = class {
      constructor(c: () => void) { roCb = c; }
      observe() {}
      disconnect() {}
    } as unknown as ROCtor;
    const queued: (() => void)[] = [];
    bindMapViewport(map, {} as Element, { RO, visualViewport: null, raf: (cb) => { queued.push(cb); } });
    roCb(); roCb(); roCb();
    expect(queued.length).toBe(1);
    queued.shift()!();
    expect(calls).toBe(1);
  });
});

describe("map container CSS", () => {
  it("pins #map to the viewport and gives html/body a dvh height fallback", () => {
    const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
    expect(css).toMatch(/html, body \{[^}]*width: 100%;[^}]*height: 100%;[^}]*height: 100dvh;/);
    expect(css).toMatch(/#map \{ position: fixed; inset: 0; width: 100%; height: 100%; \}/);
  });
});
