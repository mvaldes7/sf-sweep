/** Submit-payload validation for photo reports. Pure. */
import { normalizeClock, parseDay, normalizeWeeks } from "./corrections";

export const SF_LAT = { min: 37.6, max: 37.9 };
export const SF_LNG = { min: -122.6, max: -122.3 };
export const MAX_NOTE_CHARS = 500;
export const MAX_DAYS = 7;

export interface SubmitFields {
  cnn: string;
  side: "L" | "R";
  street?: string;
  limits?: string;
  blockside?: string;
  lat: number;
  lng: number;
  days?: string[]; // Sun..Sat, optional
  from?: string;
  to?: string;
  weeks?: number[];
  holidays?: boolean;
  note?: string;
  turnstile: string;
}

export function validateSubmit(b: Partial<SubmitFields>): string | null {
  if (typeof b.cnn !== "string" || !/^\d{1,12}$/.test(b.cnn)) return "cnn is required";
  if (b.side !== "L" && b.side !== "R") return "side must be L or R";
  if (typeof b.lat !== "number" || !Number.isFinite(b.lat) || b.lat < SF_LAT.min || b.lat > SF_LAT.max) return "location outside San Francisco";
  if (typeof b.lng !== "number" || !Number.isFinite(b.lng) || b.lng < SF_LNG.min || b.lng > SF_LNG.max) return "location outside San Francisco";
  if (b.street != null && (typeof b.street !== "string" || b.street.length > 80)) return "street too long";
  if (b.limits != null && (typeof b.limits !== "string" || b.limits.length > 120)) return "limits too long";
  if (b.blockside != null && (typeof b.blockside !== "string" || b.blockside.length > 40)) return "blockside too long";
  if (b.note != null && (typeof b.note !== "string" || b.note.length > MAX_NOTE_CHARS)) return "note too long";
  if (typeof b.turnstile !== "string" || b.turnstile.length < 8 || b.turnstile.length > 4096) return "turnstile token required";
  const hasTime = b.from != null && b.from !== "" || b.to != null && b.to !== "";
  const hasDays = Array.isArray(b.days) && b.days.length > 0;
  if (hasTime || hasDays) {
    if (!hasDays || !b.days) return "days and times must be provided together";
    if (b.days.length > MAX_DAYS) return "too many days";
    for (const d of b.days) if (!parseDay(String(d))) return "invalid day";
    if (!normalizeClock(String(b.from ?? ""), false) || !normalizeClock(String(b.to ?? ""), true)) return "invalid time";
    if (normalizeClock(String(b.from), false) === normalizeClock(String(b.to), true)) return "from and to must differ";
    if (b.weeks != null && !normalizeWeeks(b.weeks)) return "invalid weeks";
  }
  return null;
}

export function fieldsFromForm(form: FormData): Partial<SubmitFields> {
  const num = (k: string): number | undefined => {
    const v = form.get(k);
    if (v == null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : Number.NaN;
  };
  const str = (k: string): string | undefined => {
    const v = form.get(k);
    return typeof v === "string" ? v : undefined;
  };
  let days: string[] | undefined;
  const rawDays = str("days");
  if (rawDays) {
    try { days = JSON.parse(rawDays) as string[]; } catch { days = rawDays.split(",").map((s) => s.trim()).filter(Boolean); }
  }
  let weeks: number[] | undefined;
  const rawWeeks = str("weeks");
  if (rawWeeks) {
    try { weeks = (JSON.parse(rawWeeks) as unknown[]).map(Number); } catch { weeks = rawWeeks.split(",").map(Number); }
  }
  const hol = str("holidays");
  return {
    cnn: str("cnn"),
    side: str("side") as SubmitFields["side"] | undefined,
    street: str("street"),
    limits: str("limits"),
    blockside: str("blockside"),
    lat: num("lat"),
    lng: num("lng"),
    days,
    from: str("from"),
    to: str("to"),
    weeks,
    holidays: hol === "1" || hol === "true",
    note: str("note"),
    turnstile: str("cf-turnstile-response") ?? str("turnstile"),
  };
}
