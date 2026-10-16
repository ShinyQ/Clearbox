interface FormatConfig {
  locale: string | undefined;
  timeZone: string | undefined;
}

const config: FormatConfig = { locale: undefined, timeZone: undefined };
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Browser locale and zone by default; tests pin en-GB and UTC so strings match the UI spec text. */
export function configureFormat(next: Partial<FormatConfig>): void {
  Object.assign(config, next);
}

const zone = (): { timeZone?: string } => (config.timeZone ? { timeZone: config.timeZone } : {});
const dtf = (opts: Intl.DateTimeFormatOptions, utc = false) =>
  new Intl.DateTimeFormat(config.locale, { ...opts, ...(utc ? { timeZone: "UTC" } : zone()) });

export function formatCount(n: number): string {
  return new Intl.NumberFormat(config.locale).format(n);
}

export function plural(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

export function formatPercent(value: number, digits = 1): string {
  return new Intl.NumberFormat(config.locale, {
    style: "percent",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function dayKey(ms: number): number {
  const key = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...zone(),
  }).format(ms);
  return Date.parse(`${key}T00:00:00Z`);
}

/** Calendar days from a to b in the configured zone (b later gives a positive number). */
export function calendarDaysBetween(a: number, b: number): number {
  return Math.round((dayKey(b) - dayKey(a)) / DAY);
}

const time = (ms: number) => dtf({ hour: "2-digit", minute: "2-digit" }).format(ms);

export function formatDayMonth(isoOrDate: string, utc = false): string {
  return dtf({ day: "numeric", month: "short" }, utc).format(Date.parse(isoOrDate));
}

export function relativeAgo(iso: string, now: number): string {
  const t = Date.parse(iso);
  const d = Math.max(0, now - t);
  if (d < MIN) return "just now";
  if (d < HOUR) return `${Math.floor(d / MIN)} min ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`;
  const days = calendarDaysBetween(t, now);
  if (days <= 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return formatDayMonth(iso);
}

export function shortAge(iso: string, now: number): string {
  const d = Math.max(0, now - Date.parse(iso));
  if (d < MIN) return "now";
  if (d < HOUR) return `${Math.floor(d / MIN)}m`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h`;
  if (d < 7 * DAY) return `${Math.floor(d / DAY)}d`;
  if (d < 365 * DAY) return `${Math.floor(d / (7 * DAY))}w`;
  return dtf({ month: "short", year: "numeric" }).format(Date.parse(iso));
}

/** "Mon 13 Oct, 08:12" (detail panel meta line, older activity rows). */
export function formatWeekdayDateTime(iso: string): string {
  const t = Date.parse(iso);
  return `${dtf({ weekday: "short", day: "numeric", month: "short" }).format(t)}, ${time(t)}`;
}

export function activityWhen(iso: string, now: number): string {
  const t = Date.parse(iso);
  const days = calendarDaysBetween(t, now);
  if (days === 0) return `Today ${time(t)}`;
  if (days === 1) return `Yesterday ${time(t)}`;
  return formatWeekdayDateTime(iso);
}

/** The next 00:00 UTC (when the daily free-tier budget resets), in local time. */
export function localResetTime(now: number): string {
  return time((Math.floor(now / DAY) + 1) * DAY);
}

/** Local clock time ("07:00") of an ISO instant. */
export const formatClock = (iso: string): string => time(Date.parse(iso));

export function formatUsd(value: number): string {
  return value < 0.005 ? "less than $0.01" : `about $${value.toFixed(2)}`;
}

export function formatMb(bytes: number): string {
  return `${formatCount(Math.round(bytes / 1_000_000))} MB`;
}

export function truncateName(name: string, max = 24): string {
  const chars = Array.from(name);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : name;
}
