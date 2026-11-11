import maplibregl, { type GeoJSONSource, type StyleSpecification, type LayerSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import { buildMarks } from "./lib/marks";
import { carRisk, nextText } from "./lib/risk";
import { findSafeSides } from "./lib/safespot";
import { bindMapViewport, trackHeight } from "./lib/layout";
import "./style.css";
import { parseAddress, loadAddresses, lookupAddresses, selectAddressSide, type AddressHit } from "./lib/addresses";
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
import { alertStatus, legendItems, sideLabel } from "./lib/labels";
import { clockFor, sortByWeekday } from "./lib/tickettimes";
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
let playing = false; // timelapse only plays when the user presses Play
let speed = 1;
let carMarker: maplibregl.Marker | null = null;
let styleReady = false;

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const palette = () => darkQuery.matches
  ? { bg: "#0b0b0d", water: "#0f1a24", road: "#1c1c22", clear: "#2a9d5c", soon: "#ffc83d", now: "#ff4d5e", casing: "#000000", safe: "#5eead4" }
  : { bg: "#eef0f3", water: "#cfe0ee", road: "#ffffff", clear: "#3f9d68", soon: "#c98a00", now: "#d7263d", casing: "#ffffff", safe: "#0f766e" };

/** Clear streets stay visible but recede so labels and amber/red read first. */
const CLEAR_OPACITY = 0.7;
const GLOW_MINZOOM = 14;
const scheme = (): Scheme => (darkQuery.matches ? "dark" : "light");

// ---------- map ----------
const protocol = new Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

function style(): StyleSpecification {
  const c = palette();
  const s: StyleSpecification = { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": c.bg } }] };
  if (config.basemapPmtilesUrl) {
    s.glyphs = location.origin + GLYPHS_URL;
    s.sources.base = basemapSource(config.basemapPmtilesUrl, location.origin);
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
    // glow is a blurred wide line (expensive fill-rate); only worth it when zoomed in
    { id: "sides-glow", type: "line", source: "sides", ...sl, minzoom: GLOW_MINZOOM, layout: { "line-cap": "round" },
      paint: { "line-color": color, "line-width": wz(2.2), "line-blur": wz(1.2), "line-opacity": ["match", ["coalesce", ["feature-state", "s"], 0], 0, 0, darkQuery.matches ? 0.35 : 0.15] } } as LayerSpecification,
    { id: "sides-casing", type: "line", source: "sides", ...sl, layout: { "line-cap": "round" },
      paint: { "line-color": c.casing, "line-width": wz(1, 2), "line-opacity": ["match", ["coalesce", ["feature-state", "s"], 0], 1, 0, 2, 0.6, 0.3] } } as LayerSpecification,
    // solid for clear (green) and sweeping now (red); hidden when amber
    { id: "sides-solid", type: "line", source: "sides", ...sl, layout: { "line-cap": "round" },
      paint: { "line-color": color, "line-width": width, "line-opacity": ["match", ["coalesce", ["feature-state", "s"], 0], 1, 0, 2, 1, CLEAR_OPACITY] } } as LayerSpecification,
    // dashed amber for within 1 hour
    { id: "sides-dash", type: "line", source: "sides", ...sl, layout: { "line-cap": "butt" },
      paint: { "line-color": c.soon, "line-width": width, "line-dasharray": [1.4, 1], "line-opacity": ["case", ["==", ["coalesce", ["feature-state", "s"], 0], 1], 1, 0] } } as LayerSpecification,
    // safe-spot highlight: only sides with feature-state safe=1 draw; set once per search, not per tick
    { id: "sides-safe", type: "line", source: "sides", ...sl, layout: { "line-cap": "round" },
      paint: { "line-color": c.safe, "line-width": wz(1.5), "line-opacity": ["case", ["==", ["coalesce", ["feature-state", "safe"], 0], 1], 1, 0] } } as LayerSpecification,
  );
  if (config.basemapPmtilesUrl) s.layers.push(...basemapLabelLayers(scheme()));
  s.sources.marks = { type: "geojson", data: { type: "FeatureCollection", features: [] } };
  s.layers.push({ id: "marks", type: "symbol", source: "marks", minzoom: 15,
    layout: { "icon-image": ["concat", "st-", ["get", "st"]], "icon-size": ["interpolate", ["linear"], ["zoom"], 15, 0.5, 18, 0.9], "icon-allow-overlap": false, "icon-padding": 2, "symbol-sort-key": ["-", 0, ["get", "rank"]] } });
  return s;
}

const map = new maplibregl.Map({
  container: "map", style: style(), center: config.cityCenter, zoom: config.cityZoom,
  attributionControl: false, // credits live in the always-visible footer (#attrib) maxBounds: [[-122.65, 37.65], [-122.3, 37.86]],
});

function addIcons() {
  for (const [name, img] of Object.entries(drawStatusIcons(palette()))) {
    if (map.hasImage(name)) map.removeImage(name);
    map.addImage(name, img, { pixelRatio: 2 });
  }
}
map.on("style.load", () => { styleReady = true; addIcons(); lastState.clear(); render(); if (safe.on) applySafe(); });
darkQuery.addEventListener("change", () => { styleReady = false; map.setStyle(style()); });
// Feature state survives tile reloads, so only re-apply once per style load (not on every
// sourcedata event, which fires for each tile while panning and used to redo 22k updates).
let sidesApplied = false;
map.on("style.load", () => { sidesApplied = false; });
map.on("sourcedata", (e) => {
  if (sidesApplied || e.sourceId !== "sides" || !e.isSourceLoaded) return;
  sidesApplied = true; lastState.clear(); render();
});

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

let marksDirty = true;
function render() {
  if (!sides.length || !styleReady) return;
  const sl = config.pmtilesUrl ? "sides" : undefined;
  let swept = 0;
  let changed = marksDirty;
  if (mode === "live") {
    const clock = clockAt(liveTime());
    for (const s of sides) {
      const st = statusFromClock(rulesById.get(s.id)!, clock, hol);
      const n = STATUS_NUM[st];
      if (lastState.get(s.id) !== n) { map.setFeatureState({ source: "sides", sourceLayer: sl, id: s.id }, { s: n }); lastState.set(s.id, n); changed = true; }
    }
  } else {
    const t = planDate();
    const parts = t === null ? null : sfParts(t);
    for (const s of sides) {
      const rules = rulesById.get(s.id)!;
      const on = parts ? sweptOnDate(rules, parts, hol) : rules.length > 0;
      if (on) swept++;
      const n = on ? 2 : 0;
      if (lastState.get(s.id) !== n) { map.setFeatureState({ source: "sides", sourceLayer: sl, id: s.id }, { s: n }); lastState.set(s.id, n); changed = true; }
    }
  }
  // Rebuilding the 22k-point marks source re-tiles it in the worker; only do it when a status changed.
  const marks = map.getSource("marks") as GeoJSONSource | undefined;
  if (changed && marks) { marks.setData(buildMarks(sides, lastState)); marksDirty = false; }
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

// ---------- legend + toast ----------
function renderLegend() {
  $("legend").innerHTML = legendItems(mode).map((i) => `<span class="lg ${i.cls}"><i class="sw"></i>${i.text}</span>`).join("");
  $("legend").setAttribute("aria-label", mode === "plan" ? "Legend: plan by day" : "Legend: live status");
}
let toastTimer = 0;
function showToast(msg: string, ms = 5000) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { t.hidden = true; t.textContent = ""; }, ms);
}

// ---------- modes ----------
function setMode(m: "live" | "plan") {
  mode = m;
  $("mode-live").setAttribute("aria-selected", String(m === "live"));
  $("mode-plan").setAttribute("aria-selected", String(m === "plan"));
  $("chips").hidden = m !== "plan";
  $("plan").hidden = m !== "plan";
  renderLegend();
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

// ---------- ticket times (lazy, static /data/sweep-times.json from scripts/build-ticket-times.ts) ----------
interface SweepTimes { range: { from: string; to: string }; sides: Record<string, [number, number, number, number][]> }
let timesP: Promise<SweepTimes | null> | null = null;
function loadTimes(): Promise<SweepTimes | null> {
  return (timesP ??= fetch(config.timesUrl).then((r) => (r.ok ? (r.json() as Promise<SweepTimes>) : null)).catch(() => null));
}
const monthFmt = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const monthOf = (ymd: string) => monthFmt.format(new Date(`${ymd}T12:00:00Z`));
function fillTimes(el: HTMLElement) {
  void loadTimes().then((t) => {
    if (!t) return;
    let any = false;
    el.querySelectorAll<HTMLElement>("[data-tix]").forEach((d) => {
      const rules = rulesById.get(Number(d.dataset.tix))!;
      const rows = t.sides[d.dataset.tix!] ?? [];
      const side = esc(d.dataset.label ?? "");
      d.innerHTML = sortByWeekday(rows.filter(([ri]) => rules[ri]), (x) => rules[x[0]]).map(([ri, med, iqr, n]) => {
        const r = rules[ri];
        const pre = `${side}${rules.length > 1 ? ` - ${esc(dayLabel(r.day))} ${hourLabel(r.from)}` : ""}: `;
        return `<div class="tix-line" title="${n} citations, middle half within ${iqr} min">${pre}Tickets usually ~${clockFor(r.from, med)} (Pacific)</div>`;
      }).join("");
      any ||= rows.length > 0;
    });
    const note = el.querySelector<HTMLElement>(".tix-note");
    if (note && any) { note.textContent = `Ticket times: typical street-cleaning citation time on this side, DataSF citations ${monthOf(t.range.from)} - ${monthOf(t.range.to)}. Posted sign wins.`; note.hidden = false; }
  });
}

function showDetail(id: number) {
  const s = byId.get(id);
  if (!s) return;
  const pair = sides.filter((x) => x.cnn === s.cnn).sort((a) => (a.side === "L" ? -1 : 1));
  const el = $("detail");
  el.innerHTML = `<button class="close" aria-label="Close">Close</button>
    <h2>${esc(s.street)}</h2><div class="muted">${esc(s.limits)} - CNN ${esc(s.cnn)}</div>
    <div class="tix-top">${pair.map((p) => `<div class="tix" data-tix="${p.id}" data-label="${esc(sideLabel(p.blockside, p.side))}"></div>`).join("")}<p class="fine tix-note" hidden></p></div>
    <div class="signs">${pair.map((p) => `<div class="side${p.id === id ? " picked" : ""}" data-id="${p.id}">
      <div class="side-h">${esc(sideLabel(p.blockside, p.side).toUpperCase())}</div>
      ${signHtml(rulesById.get(p.id)!)}${sideStatusLine(rulesById.get(p.id)!)}
      <div class="side-next">${esc(nextText(nextSweep(rulesById.get(p.id)!, Date.now(), hol), Date.now()))}</div>
      ${safe.on ? `<div class="side-safe ${safe.ids.has(p.id) ? "yes" : "no"}">${safe.ids.has(p.id) ? `No sweeping in the next ${safe.hours}h` : `Sweeping within ${safe.hours}h`}</div>` : ""}</div>`).join("")}</div>
    <p class="fine">Sign generated from DataSF fields (weekday, from/to hour, week1-5, holidays). Posted signs are authoritative.</p>
    <button class="primary" id="park">Park here</button>`;
  el.hidden = false;
  fillTimes(el);
  let chosen = id;
  el.querySelectorAll<HTMLElement>(".side").forEach((d) => d.addEventListener("click", () => {
    chosen = Number(d.dataset.id);
    el.querySelectorAll(".side").forEach((x) => x.classList.toggle("picked", x === d));
  }));
  el.querySelector(".close")!.addEventListener("click", () => { el.hidden = true; });
  $("park").addEventListener("click", () => { void park(chosen); });
}

for (const layer of ["sides-solid", "sides-dash", "sides-safe"]) {
  map.on("click", layer, (e) => { const f = e.features?.[0]; if (f?.id != null) showDetail(Number(f.id)); });
  map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
}

// ---------- safe spot ----------
const safe = { on: false, hours: 24 as 24 | 48, ids: new Set<number>(), center: [0, 0] as [number, number], fromCar: false };
const BASE_OPACITY: Record<string, unknown> = {};
const DIM = 0.12;
function applySafe() {
  const sl = config.pmtilesUrl ? "sides" : undefined;
  for (const id of ["sides-glow", "sides-casing", "sides-solid", "sides-dash"]) {
    if (!(id in BASE_OPACITY)) BASE_OPACITY[id] = map.getPaintProperty(id, "line-opacity");
    // safe sides are drawn by sides-safe on top; everything else is dimmed. One restyle per toggle.
    map.setPaintProperty(id, "line-opacity", safe.on
      ? (id === "sides-glow" ? 0 : ["case", ["==", ["coalesce", ["feature-state", "safe"], 0], 1], 0, ["*", DIM, BASE_OPACITY[id] as number]])
      : BASE_OPACITY[id] as maplibregl.ExpressionSpecification);
  }
  for (const id of safe.ids) map.setFeatureState({ source: "sides", sourceLayer: sl, id }, { safe: safe.on ? 1 : 0 });
  map.setLayoutProperty("marks", "visibility", safe.on ? "none" : "visible");
}
function runSafe() {
  const sl = config.pmtilesUrl ? "sides" : undefined;
  for (const id of safe.ids) map.setFeatureState({ source: "sides", sourceLayer: sl, id }, { safe: 0 });
  const car = loadCar();
  safe.fromCar = !!car;
  safe.center = car ? [car.lng, car.lat] : [map.getCenter().lng, map.getCenter().lat];
  const r = findSafeSides(sides, rulesById, safe.center, Date.now(), safe.hours, hol);
  safe.ids = new Set(r.safe);
  applySafe();
  $("safe").innerHTML = `<button class="close" id="safe-close" aria-label="Close safe spots">Done</button>
    <div class="eyebrow">SAFE SPOTS NEARBY</div>
    <div class="safe-sum"><b class="safe-n">${r.safe.length}</b> of ${r.nearby} block sides within 0.5 mi of ${safe.fromCar ? "your car" : "the map center"} have no sweeping in the next ${safe.hours}h.</div>
    <div class="row"><div class="seg seg-sm" role="group" aria-label="Time window">
      <button id="safe-24" aria-pressed="${safe.hours === 24}">24h</button><button id="safe-48" aria-pressed="${safe.hours === 48}">48h</button></div>
      <span class="muted">Tap a highlighted block for its side and next sweep.</span></div>`;
  $("safe").hidden = false;
  $("safe-24").addEventListener("click", () => { safe.hours = 24; runSafe(); });
  $("safe-48").addEventListener("click", () => { safe.hours = 48; runSafe(); });
  $("safe-close").addEventListener("click", () => toggleSafe(false));
  if (map.getZoom() < 14.5) map.easeTo({ center: safe.center, zoom: 15 });
}
function toggleSafe(force?: boolean) {
  safe.on = force ?? !safe.on;
  document.body.classList.toggle("safe-on", safe.on);
  $("safe-btn").setAttribute("aria-pressed", String(safe.on));
  if (safe.on) runSafe();
  else { applySafe(); safe.ids.clear(); $("safe").hidden = true; }
  renderCar();
}
$("safe-btn").addEventListener("click", () => toggleSafe());

// ---------- car ----------
async function park(id: number) {
  const s = byId.get(id)!;
  const car: Car = { id, cnn: s.cnn, side: s.side, lng: s.mid[0], lat: s.mid[1], savedAt: Date.now() };
  saveCar(car);
  $("detail").hidden = true;
  renderCar();
  // Alerts are a separate opt-in ("Alert me" on the car card); saving never depends on push.
}

function notificationsBlocked(): boolean {
  return typeof Notification !== "undefined" && Notification.permission === "denied";
}

async function armAlert(car: Car) {
  const n = nextSweep(rulesById.get(car.id) ?? [], Date.now(), hol);
  if (!n) return;
  const fireAt = n.start - config.alertLeadMin * 60000;
  if (notificationsBlocked()) { saveCar({ ...car, alert: false, alertError: undefined, alertNote: "blocked" }); renderCar(); return; }
  try {
    await enablePush({ cnn: car.cnn, side: car.side, lat: car.lat, lng: car.lng }, Math.max(fireAt, Date.now() + 60000));
    saveCar({ ...car, alert: true, alertError: undefined, alertNote: undefined });
  } catch (err) {
    if (notificationsBlocked()) saveCar({ ...car, alert: false, alertError: undefined, alertNote: "blocked" });
    else saveCar({ ...car, alert: false, alertError: String((err as Error).message || err) });
  }
  renderCar();
}

let carExpanded = false;
function renderCar() {
  const car = loadCar();
  const el = $("car");
  carMarker?.remove(); carMarker = null;
  if (!car || !byId.has(car.id)) { el.hidden = true; return; }
  const s = byId.get(car.id)!;
  const rules = rulesById.get(car.id)!;
  const now = Date.now();
  const n = nextSweep(rules, now, hol);
  const left = n ? Math.max(0, n.start - now) : 0;
  const d = Math.floor(left / 86400000), h = Math.floor((left % 86400000) / 3600000), m = Math.floor((left % 3600000) / 60000);
  const al = alertStatus(car, { pushSupported: pushSupported(), apiConfigured: !!(config.apiBase && config.vapidPublicKey), blocked: notificationsBlocked() });
  const risk = carRisk(n, now);
  el.innerHTML = `<div class="car-bar">
      <div class="car-bar-main"><div class="car-bar-top"><b>My car</b><span class="risk ${risk.level}" role="status" aria-live="polite">${esc(risk.text)}</span></div>
        <div class="muted car-bar-sub">${esc(s.street)}, ${esc(sideLabel(s.blockside, s.side))}</div>
        <div class="car-note ${al.kind}">${esc(al.text)}</div>
        <div class="car-actions">${al.canArm ? `<button class="pill sm" id="car-alert">Alert me</button>` : ""}<button class="pill sm" id="car-safe" aria-pressed="${safe.on}">Safe spot nearby</button></div></div>
      <button class="pill car-toggle" id="car-toggle" aria-expanded="${carExpanded}" aria-controls="car-more">${carExpanded ? "Less" : "More"}</button>
    </div>
    <div id="car-more" class="car-more">
    <div class="car-h"><span class="muted">saved on this device - no account</span></div>
    <div class="car-grid"><div>
      <div class="eyebrow">NEXT SWEEP ON YOUR SIDE IN</div>
      ${n ? `<div class="count"><span>${d}<small>day</small></span><span>${h}<small>hrs</small></span><span>${m}<small>min</small></span></div>
      <div class="moveby"><div class="eyebrow">MOVE BY</div><div>${fullFmt.format(n.start)}</div></div>` : `<div class="muted">No sweeping scheduled in the next 10 weeks</div>`}
      <div class="muted">${esc(s.street)}, ${esc(sideLabel(s.blockside, s.side))} - ${esc(s.limits)}</div>
    </div><div class="car-sign">${signHtml(n ? rules.filter((r) => ruleActiveAt(r, n.start, hol)).slice(0, 1) : rules.slice(0, 1))}</div></div>
    <div class="row">
      ${n ? `<button class="pill" id="car-ics">Add .ics reminder</button>` : ""}
      <a class="pill" href="https://www.google.com/maps/dir/?api=1&destination=${car.lat},${car.lng}" target="_blank" rel="noopener">Directions</a>
      <button class="pill" id="car-moved">I moved</button>
    </div></div>`;
  el.classList.toggle("expanded", carExpanded);
  el.querySelector("#car-safe")?.addEventListener("click", () => toggleSafe());
  el.querySelector("#car-toggle")?.addEventListener("click", () => { carExpanded = !carExpanded; renderCar(); });
  el.hidden = false;
  carMarker = new maplibregl.Marker({ color: "#ffffff" }).setLngLat([car.lng, car.lat]).addTo(map);
  el.querySelector("#car-alert")?.addEventListener("click", () => { void armAlert(car); });
  el.querySelector("#car-ics")?.addEventListener("click", () => {
    if (!n) return;
    const blob = new Blob([buildIcs({ start: n.start, end: n.end, title: `Move car: street cleaning on ${s.street}`, location: `${s.street} (${s.limits}), ${sideLabel(s.blockside, s.side)}, San Francisco`, alarmMin: config.alertLeadMin })], { type: "text/calendar" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "street-cleaning.ics"; a.click();
  });
  el.querySelector("#car-moved")?.addEventListener("click", () => { void disablePush().finally(() => { clearCar(); renderCar(); }); });
}

// ---------- search + locate ----------
const q = $("q") as HTMLInputElement;
const results = $("results");
let addressHits: AddressHit[] = [];
let searchVersion = 0;
let activeResult = -1;
function displayResults(html: string) {
  results.innerHTML = html;
  results.hidden = !html;
  activeResult = -1;
  q.removeAttribute("aria-activedescendant");
  q.setAttribute("aria-expanded", String(!!html));
}
q.addEventListener("input", () => { void updateSearch(); });
async function updateSearch() {
  const version = ++searchVersion;
  const query = q.value;
  addressHits = [];
  if (parseAddress(query)) {
    displayResults("");
    $("search-status").textContent = "Loading addresses...";
    try {
      const index = await loadAddresses();
      if (version !== searchVersion) return;
      addressHits = lookupAddresses(index, query);
      displayResults(addressHits.map((h, i) => `<li id="search-${i}" role="option" aria-selected="false" data-address="${i}"><b>${esc(h.label)}</b> <span class="muted">${h.baseFallback ? "Base address; suffix not found" : "Address point"}</span></li>`).join(""));
      $("search-status").textContent = addressHits.length ? `${addressHits.length} address results` : "No address found. Try the street name without a house number.";
    } catch {
      if (version === searchVersion) $("search-status").textContent = "Addresses unavailable. Try the street name without a house number.";
    }
  } else {
    const hits = searchStreets(sides, query);
    displayResults(hits.map((h, i) => `<li id="search-${i}" role="option" aria-selected="false" data-id="${h.id}"><b>${esc(h.street)}</b> <span class="muted">${esc(h.limits)}</span></li>`).join(""));
    $("search-status").textContent = "";
  }
}
function chooseResult(li: HTMLElement) {
  ++searchVersion; // discard a pending async search after selection
  if (li.dataset.address !== undefined) {
    const hit = addressHits[Number(li.dataset.address)];
    if (!hit) return;
    q.value = hit.label;
    map.flyTo({ center: hit.point, zoom: 17 });
    const side = selectAddressSide(sides, hit);
    if (side) {
      showDetail(side.id);
      showToast("Estimated address side selected. Check both sides and the posted sign.");
    } else {
      $("detail").hidden = true;
      showToast("Address found; no matching sweeping segment. Check the posted sign.");
    }
  } else {
    const s = byId.get(Number(li.dataset.id));
    if (!s) return;
    q.value = `${s.street}, ${s.limits}`;
    map.flyTo({ center: s.mid, zoom: 17 });
    showDetail(s.id);
  }
  displayResults(""); $("search-status").textContent = ""; q.blur();
}
results.addEventListener("click", (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>("li");
  if (li) chooseResult(li);
});
q.addEventListener("keydown", e => {
  const options = Array.from(results.querySelectorAll<HTMLElement>("li"));
  if (e.key === "Escape") { ++searchVersion; displayResults(""); $("search-status").textContent = ""; }
  if (!options.length) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    activeResult = (activeResult + (e.key === "ArrowDown" ? 1 : options.length - 1) + options.length) % options.length;
    options.forEach((el, i) => el.setAttribute("aria-selected", String(i === activeResult)));
    q.setAttribute("aria-activedescendant", options[activeResult].id);
    options[activeResult].scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    e.preventDefault(); chooseResult(options[Math.max(0, activeResult)]);
  }
});
// iOS Safari often shrinks the visual viewport for the keyboard and does not
// fire a container ResizeObserver event when it dismisses; bump the canvas then.
q.addEventListener("blur", () => { requestAnimationFrame(() => map.resize()); });
q.addEventListener("focus", () => { requestAnimationFrame(() => map.resize()); });
function locate(silent = false) {
  if (!("geolocation" in navigator)) return;
  navigator.geolocation.getCurrentPosition(
    (p) => map.flyTo({ center: [p.coords.longitude, p.coords.latitude], zoom: 16.5 }),
    () => { if (!silent) showToast("Location unavailable. Showing the city view."); },
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
trackHeight($("car"), document.documentElement, "--car-h", window.ResizeObserver);
trackHeight($("attrib"), document.documentElement, "--attrib-h", window.ResizeObserver);
bindMapViewport(map, map.getContainer(), { RO: window.ResizeObserver });
loadIndex().then(() => { render(); renderCar(); const car = loadCar(); if (car) map.jumpTo({ center: [car.lng, car.lat], zoom: 16.5 }); else locate(true); })
  .catch((e) => { $("tl-label").textContent = `Could not load sweep data (${(e as Error).message}). Run the data pipeline, see docs/DATA.md.`; });
if ("serviceWorker" in navigator && import.meta.env.PROD) void navigator.serviceWorker.register("/sw.js");
