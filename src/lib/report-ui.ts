/** "Report a sign" form. Only mounted when config.photoReports is on (off by default). */
import { config } from "../config";
import type { SideRecord } from "./data";

declare global {
  interface Window {
    turnstile?: { render: (el: HTMLElement, opts: { sitekey: string; callback: (t: string) => void }) => void };
  }
}

export function reportsEnabled(cfg: Pick<typeof config, "photoReports" | "reportsApiBase"> = config): boolean {
  return !!(cfg.photoReports && cfg.reportsApiBase);
}

/** Turnstile widget and token are used only when a public site key is set. Off in v1. */
export function turnstileEnabled(siteKey: string = config.turnstileSiteKey): boolean {
  return !!siteKey;
}

/** Widget markup. Empty when Turnstile is off so the script is never loaded. */
export function reportTurnstileSlot(siteKey: string = config.turnstileSiteKey): string {
  return turnstileEnabled(siteKey) ? '<div id="report-turnstile"></div>' : "";
}

let token = "";
let turnstileLoaded: Promise<void> | null = null;

function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  return (turnstileLoaded ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("turnstile failed to load"));
    document.head.appendChild(s);
  }));
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function openReportForm(side: SideRecord, host: HTMLElement): void {
  if (!reportsEnabled()) return;
  const existing = document.getElementById("report-form");
  existing?.remove();
  const el = document.createElement("div");
  el.id = "report-form";
  el.className = "report-form";
  el.innerHTML = `
    <div class="report-h">
      <div class="eyebrow">REPORT A SIGN</div>
      <button type="button" class="close" id="report-close" aria-label="Close report form">Close</button>
    </div>
    <p class="fine">Photograph only the street-cleaning sign. The map will not change until a report is reviewed.</p>
    <form id="report-inner">
      <label class="report-field">Photo
        <input type="file" name="photo" accept="image/jpeg,image/png,image/webp,image/*" capture="environment" required>
      </label>
      <div class="muted" id="report-loc">Getting your location...</div>
      <input type="hidden" name="lat" id="report-lat">
      <input type="hidden" name="lng" id="report-lng">
      <input type="hidden" name="cnn" value="${esc(side.cnn)}">
      <input type="hidden" name="side" value="${esc(side.side)}">
      <input type="hidden" name="street" value="${esc(side.street)}">
      <input type="hidden" name="limits" value="${esc(side.limits)}">
      <input type="hidden" name="blockside" value="${esc(side.blockside)}">
      <fieldset class="report-days">
        <legend>Days (optional)</legend>
        ${DAYS.map((d) => `<label><input type="checkbox" name="day" value="${d}"> ${d}</label>`).join("")}
      </fieldset>
      <div class="row">
        <label class="report-field">From (optional)
          <input type="time" name="from" step="60">
        </label>
        <label class="report-field">To (optional)
          <input type="time" name="to" step="60">
        </label>
      </div>
      <label class="report-check"><input type="checkbox" name="holidays" value="0" checked> Except holidays</label>
      <label class="report-field">Note (optional)
        <input type="text" name="note" maxlength="500" autocomplete="off">
      </label>
      ${reportTurnstileSlot()}
      <p class="fine" id="report-status" role="status"></p>
      <button type="submit" class="primary" id="report-submit">Submit report</button>
    </form>`;
  host.appendChild(el);
  el.querySelector("#report-close")!.addEventListener("click", () => el.remove());
  fillLocation(side, el);
  if (turnstileEnabled()) {
    void loadTurnstile().then(() => {
      const box = el.querySelector<HTMLElement>("#report-turnstile");
      if (box && window.turnstile) window.turnstile.render(box, { sitekey: config.turnstileSiteKey, callback: (t) => { token = t; } });
    }).catch((e) => setStatus(el, String((e as Error).message || e)));
  }
  el.querySelector("#report-inner")!.addEventListener("submit", (ev) => { ev.preventDefault(); void submitReport(el, ev.target as HTMLFormElement); });
}

function fillLocation(side: SideRecord, el: HTMLElement) {
  const lat = el.querySelector<HTMLInputElement>("#report-lat")!;
  const lng = el.querySelector<HTMLInputElement>("#report-lng")!;
  const label = el.querySelector("#report-loc")!;
  const fallback = () => {
    lat.value = String(side.mid[1]);
    lng.value = String(side.mid[0]);
    label.textContent = `Location: this block (device location unavailable). You can still submit.`;
  };
  if (!("geolocation" in navigator)) { fallback(); return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      lat.value = String(pos.coords.latitude);
      lng.value = String(pos.coords.longitude);
      label.textContent = `Location from this device (${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}).`;
    },
    () => fallback(),
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 30_000 },
  );
}

async function submitReport(el: HTMLElement, form: HTMLFormElement) {
  const status = setStatus(el, "Sending...");
  const submit = el.querySelector<HTMLButtonElement>("#report-submit");
  if (submit) submit.disabled = true;
  try {
    if (turnstileEnabled() && !token) throw new Error("Complete the bot check first");
    const fd = new FormData(form);
    const photo = fd.get("photo");
    if (!(photo instanceof File) || !photo.size) throw new Error("Choose one photo of the sign");
    if (turnstileEnabled()) fd.set("cf-turnstile-response", token);
    const days = [...form.querySelectorAll<HTMLInputElement>("input[name=day]:checked")].map((c) => c.value);
    if (days.length) fd.set("days", JSON.stringify(days));
    fd.delete("day");
    const exceptHol = form.querySelector<HTMLInputElement>("input[name=holidays]");
    fd.set("holidays", exceptHol && exceptHol.checked ? "0" : "1");
    const res = await fetch(`${config.reportsApiBase.replace(/\/$/, "")}/api/reports`, { method: "POST", body: fd });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; id?: string };
    if (!res.ok || !data.ok) throw new Error(data.error || `Submit failed (${res.status})`);
    status.textContent = "Thanks. The report is in the review queue. The map will not change until it is checked.";
    form.hidden = true;
  } catch (e) {
    status.textContent = String((e as Error).message || e);
    if (submit) submit.disabled = false;
  }
}

function setStatus(el: HTMLElement, text: string): HTMLElement {
  const s = el.querySelector<HTMLElement>("#report-status")!;
  s.textContent = text;
  return s;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
