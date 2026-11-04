/** Draw status marker images on canvas (no glyph server needed). Shape + text so color is never the only cue. */
export function drawStatusIcons(c: { clear: string; soon: string; now: string; bg: string }): Record<string, ImageData> {
  const make = (color: string, label: string, glyph: "x" | "clock" | "check") => {
    const W = 120, H = 44;
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const g = cv.getContext("2d")!;
    g.fillStyle = c.bg; g.globalAlpha = 0.85;
    g.beginPath(); g.roundRect(1, 1, W - 2, H - 2, 21); g.fill();
    g.globalAlpha = 1; g.strokeStyle = color; g.lineWidth = 3; g.stroke();
    const cx = 22, cy = H / 2;
    g.beginPath(); g.arc(cx, cy, 12, 0, Math.PI * 2); g.stroke();
    g.beginPath();
    if (glyph === "x") { g.moveTo(cx - 6, cy - 6); g.lineTo(cx + 6, cy + 6); g.moveTo(cx + 6, cy - 6); g.lineTo(cx - 6, cy + 6); }
    if (glyph === "clock") { g.moveTo(cx, cy - 7); g.lineTo(cx, cy); g.lineTo(cx + 5, cy + 3); }
    if (glyph === "check") { g.moveTo(cx - 6, cy); g.lineTo(cx - 1, cy + 5); g.lineTo(cx + 7, cy - 5); }
    g.stroke();
    g.fillStyle = color; g.font = "bold 20px system-ui, sans-serif"; g.textBaseline = "middle";
    g.fillText(label, 42, cy + 1);
    return g.getImageData(0, 0, W, H);
  };
  return { "st-now": make(c.now, "NOW", "x"), "st-soon": make(c.soon, "1 HR", "clock"), "st-clear": make(c.clear, "OK", "check") };
}
