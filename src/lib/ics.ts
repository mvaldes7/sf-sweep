/** Build a minimal iCalendar reminder (fallback when Web Push is unavailable). */
export function buildIcs(opts: { start: number; end: number; title: string; location: string; alarmMin: number }): string {
  const f = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const esc = (s: string) => s.replace(/[\\,;]/g, (m) => "\\" + m);
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//sf-sweep//EN", "BEGIN:VEVENT",
    `UID:${opts.start}-${Math.random().toString(36).slice(2)}@sf-sweep`,
    `DTSTAMP:${f(Date.now())}`, `DTSTART:${f(opts.start)}`, `DTEND:${f(opts.end)}`,
    `SUMMARY:${esc(opts.title)}`, `LOCATION:${esc(opts.location)}`,
    "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${esc(opts.title)}`, `TRIGGER:-PT${opts.alarmMin}M`, "END:VALARM",
    "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n");
}
