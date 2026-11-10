/** Keeps a CSS variable in sync with an element's rendered height so other panels can sit above it. */
export interface ROLike { observe(el: Element): void; disconnect(): void }
export type ROCtor = new (cb: () => void) => ROLike;

export function cssPx(h: number): string { return `${Math.max(0, Math.ceil(h))}px`; }

export function trackHeight(
  el: HTMLElement, root: { style: { setProperty(k: string, v: string): void } }, varName: string, RO: ROCtor | undefined,
): () => void {
  const update = () => root.style.setProperty(varName, cssPx(el.hidden ? 0 : el.getBoundingClientRect().height));
  update();
  if (!RO) return () => {};
  const ro = new RO(update);
  ro.observe(el);
  return () => ro.disconnect();
}

/**
 * MapLibre's default trackResize only listens to window.resize. On iOS Safari
 * (keyboard dismissal after search, standalone PWA, orientation, bfcache) the
 * #map container can change size without that event, leaving the canvas stuck
 * at an earlier width/height with black around it.
 */
export interface MapResizable { resize(): void }
export interface EventTargetLike {
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}
export type Raf = (cb: () => void) => unknown;

export function bindMapViewport(
  map: MapResizable,
  container: Element,
  opts: { RO?: ROCtor; visualViewport?: EventTargetLike | null; win?: EventTargetLike; raf?: Raf } = {},
): () => void {
  const raf: Raf = opts.raf ?? (typeof requestAnimationFrame === "function"
    ? requestAnimationFrame
    : (cb) => { cb(); });
  let scheduled = false;
  const resize = () => {
    if (scheduled) return;
    scheduled = true;
    raf(() => {
      scheduled = false;
      map.resize();
    });
  };
  // A second frame lets iOS finish keyboard / rotation layout before we measure.
  const late = () => { resize(); raf(() => resize()); };

  const RO = opts.RO ?? (typeof ResizeObserver === "function" ? ResizeObserver : undefined);
  const ro = RO ? new RO(resize) : undefined;
  ro?.observe(container);

  const vv = opts.visualViewport !== undefined
    ? opts.visualViewport
    : (typeof visualViewport === "undefined" ? null : visualViewport);
  const win = opts.win ?? (typeof window === "undefined" ? undefined : window);

  vv?.addEventListener("resize", late);
  vv?.addEventListener("scroll", resize);
  win?.addEventListener("orientationchange", late);
  win?.addEventListener("pageshow", late);

  resize();

  return () => {
    ro?.disconnect();
    vv?.removeEventListener("resize", late);
    vv?.removeEventListener("scroll", resize);
    win?.removeEventListener("orientationchange", late);
    win?.removeEventListener("pageshow", late);
  };
}
