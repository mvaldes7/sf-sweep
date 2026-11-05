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
