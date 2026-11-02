// Offset a lon/lat LineString perpendicular to its direction by a distance in meters.
// Positive = left of the digitized direction, negative = right.
const R = 6378137;

export function offsetLine(coords, meters) {
  if (coords.length < 2) return coords;
  const lat0 = (coords[0][1] * Math.PI) / 180;
  const kx = (Math.PI / 180) * R * Math.cos(lat0);
  const ky = (Math.PI / 180) * R;
  const pts = coords.map(([x, y]) => [x * kx, y * ky]);
  const normals = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dy = pts[i + 1][1] - pts[i][1];
    const len = Math.hypot(dx, dy) || 1;
    normals.push([-dy / len, dx / len]); // left normal
  }
  const out = pts.map((p, i) => {
    const a = normals[Math.max(0, i - 1)];
    const b = normals[Math.min(normals.length - 1, i)];
    let nx = a[0] + b[0];
    let ny = a[1] + b[1];
    const nlen = Math.hypot(nx, ny) || 1;
    nx /= nlen; ny /= nlen;
    // miter scale, clamped to avoid spikes at sharp corners
    const cos = nx * b[0] + ny * b[1];
    const scale = Math.min(2, 1 / Math.max(cos, 0.5));
    return [p[0] + nx * meters * scale, p[1] + ny * meters * scale];
  });
  return out.map(([x, y]) => [round(x / kx), round(y / ky)]);
}

export function midpoint(coords) {
  const i = Math.floor((coords.length - 1) / 2);
  const a = coords[i], b = coords[Math.min(i + 1, coords.length - 1)];
  return [round((a[0] + b[0]) / 2), round((a[1] + b[1]) / 2)];
}

function round(v) { return Math.round(v * 1e6) / 1e6; }
