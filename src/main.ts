import maplibregl, { type GeoJSONSource, type StyleSpecification, type LayerSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import type { Feature } from "geojson";
import "./style.css";
import { GLYPHS_URL, type Scheme, basemapLabelLayers, basemapLayers, basemapSource } from "./lib/basemap";
import { config } from "./config";
import holidaysJson from "./data/holidays.json";
import { decodeRule, searchStreets, type SideRecord, type SweepIndex } from "./lib/data";
import {
  HolidayTable, clockAt, ruleActiveAt, dayLabel, hourLabel, nextSweep, sfParts, statusFromClock, sweptOnDate,
  weekOfMonth, weeksLabel, type Holiday, type Rule, type Status,
} from "./lib/schedule";
import { buildIcs } from "./lib/ics";
import { drawStatusIcons } from "./icons";
import { loadCar, saveCar, clearCar, type Car } from "./lib/car";
import { enablePush, disablePush, pushSupported } from "./push";

const hol = new HolidayTable(holidaysJson.holidays as Holiday[]);
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const STATUS_NUM: Record<Status, number> = { clear: 0, soon: 1, now: 2 };
const TICK_MIN = 5;
const TICKS = 72; // 6 h

let sides: SideRecord[] = [];
const byId = new Map<number, SideRecord>();
const rulesById = new Map<number, Rule[]>();
const lastState = new Map<number, number>();
let mode: "live" | "plan" = "live";
let planDay: "today" | "all" | number = "today";
let tick = 0;
let playing = true;
let speed = 1;
let carMarker: maplibregl.Marker | null = null;
let styleReady = false;

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const palette = () => darkQuery.matches
  ? { bg: "#0b0b0d", water: "#0f1a24", road: "#1c1c22", clear: "#2bd96b", soon: "#ffc83d", now: "#ff4d5e", casing: "#000000" }
  : { bg: "#eef0f3", water: "#cfe0ee", road: "#ffffff", clear: "#0f9d47", soon: "#c98a00", now: "#d7263d", casing: "#ffffff" };

const scheme = (): Scheme => (darkQuery.matches ? "dark" : "light");

// ---------- map ----------
const protocol = new Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

function style(): StyleSpecification {
  const c = palette();
  const s: StyleSpecification = { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": c.bg } }] };
  if (config.basemapPmtilesUrl) {
    s.glyphs = location.origin + GLYPHS_URL;
    s.sources.base = basemapSource(config.basemapPmtilesUrl);
    s.layers.push(...basemapLayers(scheme()));
  }
  s.sources.sides = config.pmtilesUrl
    ? { type: "vector", url: `pmtiles://${config.pmtilesUrl}`, promoteId: "fid" }
    : { type: "geojson", data: config.geojsonUrl, promoteId: "fid" };
  const sl = config.pmtilesUrl ? { "source-layer": "sides" } : {};
  const W: [number, number][] = [[12, 1.2], [15, 4], [17, 10], [19, 22]];
  const wz = (k: number, add = 0): maplibregl.ExpressionSpecification =>
    ["interpolate", ["exponential", 1.6], ["zoom"], ...W.flatMap(([z, w]) => [z, w * k + add])] as maplibregl.ExpressionSpecification;
  const width = wz(1);
  const color: maplibregl.ExpressionSpecification = ["match", ["coalesce", ["feature-state", "s"], 0], 2, c.now, 1, c.soon, c.clear];
  s.layers.push(
    { id: "sides-glow", type: "line", source: "sides", ...sl, layout: { "line-cap": "round" },
      paint: { "line-color": color, "line-width": wz(2.2), "line-blur": wz(1.2), "line-opacity": darkQuery.matches ? 0.35 : 0.15 } } as LayerSpecification,
    { id: "sides-casing", type: "line", source: "sides", ...sl, layout: { "line-cap": "round" },
      paint: { "line-color": c.casing, "line-width": wz(1, 2), "line-opacity": ["case", ["==", ["coalesce", ["feature-state", "s"], 0], 1], 0, 0.6] } } as LayerSpecification,
    // solid for clear (green) and sweeping now (red); hidden when amber
    { id: "sides-solid", type: "line", source: "sides", ...sl, layout: { "line-cap": "round" },
      paint: { "line-color": color, "line-width": width, "line-opacity": ["case", ["==", ["coalesce", ["feature-state", "s"], 0], 1], 0, 1] } } as LayerSpecification,
    // dashed amber for within 1 hour
    { id: "sides-dash", type: "line", source: "sides", ...sl, layout: { "line-cap": "butt" },
      paint: { "line-color": c.soon, "line-width": width, "line-dasharray": [1.4, 1], "line-opacity": ["case", ["==", ["coalesce", ["feature-state", "s"], 0], 1], 1, 0] } } as LayerSpecification,
  );
  if (config.basemapPmtilesUrl) s.layers.push(...basemapLabelLayers(scheme()));
  s.sources.marks = { type: "geojson", data: { type: "FeatureCollection", features: [] } };
  s.layers.push({ id: "marks", type: "symbol", source: "marks", minzoom: 15,
    layout: { "icon-image": ["concat", "st-", ["get", "st"]], "icon-size": ["interpolate", ["linear"], ["zoom"], 15, 0.5, 18, 0.9], "icon-allow-overlap": false, "icon-padding": 2, "symbol-sort-key": ["-", 0, ["get", "rank"]] } });
  return s;
}

const map = new maplibregl.Map({
  container: "map", style: style(), center: config.cityCenter, zoom: config.cityZoom,
  attributionControl: { compact: true }, maxBounds: [[-122.65, 37.65], [-122.3, 37.86]],
});

function addIcons() {
  for (const [name, img] of Object.entries(drawStatusIcons(palette()))) {
    if (map.hasImage(name)) map.removeImage(name);
    map.addImage(name, img, { pixelRatio: 2 });
  }
}
map.on("style.load", () => { styleReady = true; addIcons(); lastState.clear(); render(); });
darkQuery.addEventListener("change", () => { styleReady = false; map.setStyle(style()); });
map.on("sourcedata", (e) => { if (e.sourceId === "sides" && e.isSourceLoaded) { lastState.clear(); render(); } });

// ---------- data ----------
async function loadIndex() {
  const res = await fetch(config.indexUrl);
  if (!res.ok) throw new Error(`index ${res.status}`);
  const idx = (await res.json()) as SweepIndex;
  sides = idx.sides;
  for (const s of sides) { byId.set(s.id, s); rulesById.set(s.id, s.r.map(decodeRule)); }
}

// ---------- time ----------
function liveTime(): number {
  const now = Date.now();
  return now - (now % 60000) + tick * TICK_MIN * 60000;
}

function planDate(): number | null {
  if (planDay === "all") return null;
  const now = Date.now();
  if (planDay === "today") return now;
  const today = sfParts(now).dow;
  const delta = (planDay - today + 7) % 7;
  return now + delta * 86400000;
}

function render() {
  if (!sides.length || !styleReady) return;
  const sl = config.pmtilesUrl ? "sides" : undefined;
  const points: Feature[] = [];
  let swept = 0;
  if (mode === "live") {
    const clock = clockAt(liveTime());
    for (const s of sides) {
      const st = statusFromClock(rulesById.get(s.id)!, clock, hol);
      const n = STATUS_NUM[st];
      if (lastState.get(s.id) !== n) { map.setFeatureState({ source: "sides", sourceLayer: sl, id: s.id }, { s: n }); lastState.set(s.id, n); }
      points.push({ type: "Feature", properties: { st, rank: n }, geometry: { type: "Point", coordinates: s.mid } });
    }
  } else {
    const t = planDate();
    const parts = t === null ? null : sfParts(t);
    for (const s of sides) {
      const rules = rulesById.get(s.id)!;
      const on = parts ? sweptOnDate(rules, parts, hol) : rules.length > 0;
      if (on) swept++;
      const n = on ? 2 : 0;
      if (lastState.get(s.id) !== n) { map.setFeatureState({ source: "sides", sourceLayer: sl, id: s.id }, { s: n }); lastState.set(s.id, n); }
      points.push({ type: "Feature", properties: { st: on ? "now" : "clear", rank: n }, geometry: { type: "Point", coordinates: s.mid } });
    }
  }
  (map.getSource("marks") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: points });
  renderTimeLabel();
  if (mode === "plan") renderPlan(swept);
}

const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", minute: "2-digit" });
const dateFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric" });
const fullFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function renderTimeLabel() {
  const t = liveTime();
  const label = tick === 0 ? `Live - ${timeFmt.format(t)} PT` : `+${Math.floor((tick * TICK_MIN) / 60)}h ${(tick * TICK_MIN) % 60}m - ${timeFmt.format(t)} PT`;
  $("tl-label").textContent = `${label} - solid red with x: sweeping now - dashed amber with clock: within 1 hr`;
  ($("scrub") as HTMLInputElement).value = String(tick);
}

function renderPlan(swept: number) {
  const el = $("plan");
  const t = planDate();
  if (t === null) {
    el.innerHTML = `<div class="eyebrow">PLAN - ALL DAYS</div><div class="big">Every scheduled side</div><div class="muted"><b class="red">${swept}</b> sides have a sweeping schedule. Tap a street for its weekly sign.</div>`;
    return;
  }
  const p = sfParts(t);
  const h = hol.get(p.ymd);
  el.innerHTML = `<div class="eyebrow">PLAN - SWEEPING ON</div>
    <div class="big">${dateFmt.format(t)}</div>
    <div class="muted">Week ${weekOfMonth(p.d)} of month - ${h ? `holiday: ${esc(h.name)} (daytime not enforced)` : "not a holiday"}</div>
    <div class="row"><span class="lg now"><i class="sw"></i>Swept this day - solid with x</span><span class="lg clear"><i class="sw"></i>No sweeping</span></div>
    <div class="muted"><b class="red">${swept}</b> sides swept this day. Tap a street for its time window; switch to Live for the timelapse.</div>`;
}

// ---------- timelapse ----------
let timer: number | undefined;
function schedulePlay() {
  window.clearInterval(timer);
  if (!playing || mode !== "live") return;
  timer = window.setInterval(() => { tick = (tick + 1) % (TICKS + 1); render(); }, 1000 / speed);
}
$("play").addEventListener("click", () => {
  playing = !playing;
  $("play").textContent = playing ? "Pause" : "Play";
  $("play").setAttribute("aria-label", playing ? "Pause timelapse" : "Play timelapse");
  schedulePlay();
});
$("speed").addEventListener("click", () => {
  speed = speed === 1 ? 2 : speed === 2 ? 4 : 1;
  $("speed").textContent = `${speed}x`;
  schedulePlay();
});
$("scrub").addEventListener("input", (e) => {
  tick = Number((e.target as HTMLInputElement).value);
  playing = false; $("play").textContent = "Play";
  schedulePlay(); render();
});
// keep "now" fresh when paused at tick 0
window.setInterval(() => { if (!playing && mode === "live") render(); renderCar(); }, 60000);

// ---------- modes ----------
function setMode(m: "live" | "plan") {
  mode = m;
  $("mode-live").setAttribute("aria-selected", String(m === "live"));
  $("mode-plan").setAttribute("aria-selected", String(m === "plan"));
  $("chips").hidden = m !== "plan";
  $("plan").hidden = m !== "plan";
  $("timelapse").hidden = m !== "live";
  lastState.clear();
  schedulePlay(); render();
}
$("mode-live").addEventListener("click", () => setMode("live"));
$("mode-plan").addEventListener("click", () => setMode("plan"));
function renderChips() {
  const chips: [string, typeof planDay][] = [["Today", "today"], ["All", "all"], ...["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d, i) => [d, (i + 1) % 7] as [string, number])];
  $("chips").innerHTML = chips.map(([l, v]) => `<button class="chip" data-v="${v}" aria-pressed="${v === planDay}">${l}</button>`).join("");
}
$("chips").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (!b) return;
  const v = b.dataset.v!;
  planDay = v === "today" || v === "all" ? v : Number(v);
  renderChips(); lastState.clear(); render();
});

// ---------- signs ----------
function signHtml(rules: Rule[]): string {
  if (!rules.length) return `<div class="sign"><div class="sign-h">NO SCHEDULE</div><div class="sign-sub">No sweeping data for this side</div></div>`;
  return rules.map((r) => `<div class="sign" role="img" aria-label="No parking, street cleaning ${hourLabel(r.from)} to ${hourLabel(r.to)} ${dayLabel(r.day)}">
    <div class="sign-h">NO PARKING</div>
    <div class="sign-b"><div class="sign-sub">STREET CLEANING</div>
    <div class="sign-time">${hourLabel(r.from)} TO ${hourLabel(r.to)}</div>
    <div class="sign-day">${dayLabel(r.day)}</div>
    ${r.day === "H" ? "" : `<div class="sign-weeks">${weeksLabel(r.weeks)}</div>`}
    <div class="sign-ex">${r.holidays ? "INCLUDING HOLIDAYS" : "EXCEPT HOLIDAYS"}</div></div></div>`).join("");
}

function sideStatusLine(rules: Rule[]): string {
  const now = Date.now();
  const st = statusFromClock(rules, clockAt(now), hol);
  const n = nextSweep(rules, now, hol);
  if (st === "now" && n) return `<span class="st now"><svg class="ic"><use href="#i-x"/></svg>sweeping now, until ${timeFmt.format(n.end)}</span>`;
  if (st === "soon" && n) return `<span class="st soon"><svg class="ic"><use href="#i-clock"/></svg>within 1 hr, starts ${timeFmt.format(n.start)}</span>`;
  return `<span class="st clear"><svg class="ic"><use href="#i-check"/></svg>clear${n ? ` - next ${fullFmt.format(n.start)}` : ""}</span>`;
}

function showDetail(id: number) {
  const s = byId.get(id);
  if (!s) return;
  const pair = sides.filter((x) => x.cnn === s.cnn).sort((a) => (a.side === "L" ? -1 : 1));
  const el = $("detail");
  el.innerHTML = `<button class="close" aria-label="Close">Close</button>
    <h2>${esc(s.street)}</h2><div class="muted">${esc(s.limits)} - CNN ${esc(s.cnn)}</div>
    <div class="signs">${pair.map((p) => `<div class="side${p.id === id ? " picked" : ""}" data-id="${p.id}">
      <div class="side-h">${esc((p.blockside || "").toUpperCase())} SIDE (${p.side})</div>
      ${signHtml(rulesById.get(p.id)!)}${sideStatusLine(rulesById.get(p.id)!)}</div>`).join("")}</div>
    <p class="fine">Sign generated from DataSF fields (weekday, from/to hour, week1-5, holidays). Posted signs are authoritative.</p>
    <button class="primary" id="park">Park here and alert me</button>`;
  el.hidden = false;
  let chosen = id;
  el.querySelectorAll<HTMLElement>(".side").forEach((d) => d.addEventListener("click", () => {
    chosen = Number(d.dataset.id);
    el.querySelectorAll(".side").forEach((x) => x.classList.toggle("picked", x === d));
  }));
  el.querySelector(".close")!.addEventListener("click", () => { el.hidden = true; });
  $("park").addEventListener("click", () => { void park(chosen); });
}

for (const layer of ["sides-solid", "sides-dash"]) {
  map.on("click", layer, (e) => { const f = e.features?.[0]; if (f?.id != null) showDetail(Number(f.id)); });
  map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
}

// ---------- car ----------
async function park(id: number) {
  const s = byId.get(id)!;
  const car: Car = { id, cnn: s.cnn, side: s.side, lng: s.mid[0], lat: s.mid[1], savedAt: Date.now() };
  saveCar(car);
  $("detail").hidden = true;
  renderCar();
  if (pushSupported() && config.apiBase && config.vapidPublicKey) await armAlert(car);
}

async function armAlert(car: Car) {
  const n = nextSweep(rulesById.get(car.id) ?? [], Date.now(), hol);
  if (!n) return;
  const fireAt = n.start - config.alertLeadMin * 60000;
  try {
    await enablePush({ cnn: car.cnn, side: car.side, lat: car.lat, lng: car.lng }, Math.max(fireAt, Date.now() + 60000));
    saveCar({ ...car, alert: true });
  } catch (err) {
    saveCar({ ...car, alert: false, alertError: String((err as Error).message || err) });
  }
  renderCar();
}

function renderCar() {
  const car = loadCar();
  const el = $("car");
  carMarker?.remove(); carMarker = null;
  if (!car || !byId.has(car.id)) { el.hidden = true; return; }
  const s = byId.get(car.id)!;
  const rules = rulesById.get(car.id)!;
  const now = Date.now();
  const st = statusFromClock(rules, clockAt(now), hol);
  const n = nextSweep(rules, now, hol);
  const left = n ? Math.max(0, n.start - now) : 0;
  const d = Math.floor(left / 86400000), h = Math.floor((left % 86400000) / 3600000), m = Math.floor((left % 3600000) / 60000);
  const head = st === "now" ? `<span class="st now"><svg class="ic"><use href="#i-x"/></svg>Sweeping now - move your car</span>`
    : st === "soon" ? `<span class="st soon"><svg class="ic"><use href="#i-clock"/></svg>Sweeping within 1 hr - move soon</span>`
    : `<span class="st clear"><svg class="ic"><use href="#i-check"/></svg>Clear now - safe to stay</span>`;
  const alertLine = car.alert ? "Alert 1 hr before - push on"
    : !pushSupported() ? "Push needs Home Screen install on iPhone - use the .ics reminder"
    : !config.apiBase ? "Push server not configured - use the .ics reminder"
    : car.alertError ? `Push failed: ${esc(car.alertError)}` : "Push alert off";
  el.innerHTML = `<div class="car-h"><b>My car</b><span class="muted">saved on this device - no account</span></div>
    ${head}
    <div class="car-grid"><div>
      <div class="eyebrow">NEXT SWEEP ON YOUR SIDE IN</div>
      ${n ? `<div class="count"><span>${d}<small>day</small></span><span>${h}<small>hrs</small></span><span>${m}<small>min</small></span></div>
      <div class="moveby"><div class="eyebrow">MOVE BY</div><div>${fullFmt.format(n.start)}</div></div>` : `<div class="muted">No sweeping scheduled in the next 10 weeks</div>`}
      <div class="muted">${esc(s.street)}, ${esc(s.blockside)} side - ${esc(s.limits)}</div>
    </div><div class="car-sign">${signHtml(n ? rules.filter((r) => ruleActiveAt(r, n.start, hol)).slice(0, 1) : rules.slice(0, 1))}</div></div>
    <div class="muted">${alertLine}</div>
    <div class="row">
      ${pushSupported() && config.apiBase && !car.alert ? `<button class="pill" id="car-alert">Turn on alert</button>` : ""}
      ${n ? `<button class="pill" id="car-ics">Add .ics reminder</button>` : ""}
      <a class="pill" href="https://www.google.com/maps/dir/?api=1&destination=${car.lat},${car.lng}" target="_blank" rel="noopener">Directions</a>
      <button class="pill" id="car-moved">I moved</button>
    </div>`;
  el.hidden = false;
  carMarker = new maplibregl.Marker({ color: "#ffffff" }).setLngLat([car.lng, car.lat]).addTo(map);
  el.querySelector("#car-alert")?.addEventListener("click", () => { void armAlert(car); });
  el.querySelector("#car-ics")?.addEventListener("click", () => {
    if (!n) return;
    const blob = new Blob([buildIcs({ start: n.start, end: n.end, title: `Move car: street cleaning on ${s.street}`, location: `${s.street} (${s.limits}), ${s.blockside} side, San Francisco`, alarmMin: config.alertLeadMin })], { type: "text/calendar" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "street-cleaning.ics"; a.click();
  });
  el.querySelector("#car-moved")?.addEventListener("click", () => { void disablePush().finally(() => { clearCar(); renderCar(); }); });
}

// ---------- search + locate ----------
const q = $("q") as HTMLInputElement;
const results = $("results");
q.addEventListener("input", () => {
  const hits = searchStreets(sides, q.value);
  results.hidden = hits.length === 0;
  results.innerHTML = hits.map((h) => `<li role="option" data-id="${h.id}"><b>${esc(h.street)}</b> <span class="muted">${esc(h.limits)}</span></li>`).join("");
});
results.addEventListener("click", (e) => {
  const li = (e.target as HTMLElement).closest("li");
  if (!li) return;
  const s = byId.get(Number(li.dataset.id))!;
  results.hidden = true; q.value = `${s.street}, ${s.limits}`; q.blur();
  map.flyTo({ center: s.mid, zoom: 17 });
  showDetail(s.id);
});
function locate(silent = false) {
  if (!("geolocation" in navigator)) return;
  navigator.geolocation.getCurrentPosition(
    (p) => map.flyTo({ center: [p.coords.longitude, p.coords.latitude], zoom: 16.5 }),
    () => { if (!silent) alert("Location unavailable. Showing the city view."); },
    { enableHighAccuracy: true, timeout: 10000 },
  );
}
$("locate").addEventListener("click", () => locate(false));

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// inline SVG symbols for UI status markers (shape + label, never color alone)
document.body.insertAdjacentHTML("afterbegin", `<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <symbol id="i-x" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="currentColor" stroke-width="2"/></symbol>
  <symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2"/></symbol>
  <symbol id="i-check" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 12.5l3 3 5-6" fill="none" stroke="currentColor" stroke-width="2"/></symbol>
</svg>`);

// ---------- boot ----------
renderChips();
setMode("live");
loadIndex().then(() => { render(); renderCar(); const car = loadCar(); if (car) map.jumpTo({ center: [car.lng, car.lat], zoom: 16.5 }); else locate(true); })
  .catch((e) => { $("tl-label").textContent = `Could not load sweep data (${(e as Error).message}). Run the data pipeline, see docs/DATA.md.`; });
if ("serviceWorker" in navigator && import.meta.env.PROD) void navigator.serviceWorker.register("/sw.js");
