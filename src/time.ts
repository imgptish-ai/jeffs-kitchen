/**
 * Timezone / clock helpers. This file has NO imports so it can be used by
 * both config.ts and session.ts without creating an import cycle.
 *
 * All timezone math relies on the built-in `Intl.DateTimeFormat`, which uses
 * the OS/ICU timezone database. On Node 18+ (with full ICU, which is the
 * default), passing an IANA zone like "America/Chicago" correctly accounts
 * for daylight-saving time. We never hard-code a UTC offset.
 */

/**
 * Parse a human clock time into "seconds since local midnight".
 * Accepts either:
 *   - 12h with meridiem:  "10:00 AM", "9:59:59 PM"
 *   - 24h:                "22:00", "09:59:59"
 */
export function parseClockTimeToSeconds(input: string): number {
  const s = input.trim().toUpperCase();

  // 12-hour, e.g. "10:00 AM" or "9:59:59 PM"
  const twelve = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/);
  if (twelve) {
    let h = parseInt(twelve[1]!, 10);
    const m = parseInt(twelve[2]!, 10);
    const sec = twelve[3] ? parseInt(twelve[3], 10) : 0;
    const meridiem = twelve[4];
    if (h < 1 || h > 12 || m > 59 || sec > 59) {
      throw new Error(`Invalid 12-hour time: "${input}"`);
    }
    if (h === 12) h = 0; // 12 AM -> 0, 12 PM -> handled by +12 below
    if (meridiem === 'PM') h += 12;
    return h * 3600 + m * 60 + sec;
  }

  // 24-hour, e.g. "22:00" or "09:59:59"
  const twentyFour = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (twentyFour) {
    const h = parseInt(twentyFour[1]!, 10);
    const m = parseInt(twentyFour[2]!, 10);
    const sec = twentyFour[3] ? parseInt(twentyFour[3], 10) : 0;
    if (h > 23 || m > 59 || sec > 59) {
      throw new Error(`Invalid 24-hour time: "${input}"`);
    }
    return h * 3600 + m * 60 + sec;
  }

  throw new Error(`Invalid time format: "${input}". Use "HH:MM" or "H:MM AM/PM".`);
}

/**
 * Given a UTC epoch (ms) and an IANA timezone, return the local wall-clock
 * time in that zone as hours/minutes/seconds plus "seconds of day".
 * Uses hourCycle "h23" so midnight is 00, never 24.
 */
export function getZonedSecondsOfDay(
  ms: number,
  timeZone: string,
): { secondsOfDay: number; hour: number; minute: number; second: number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(ms));
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const p of parts) {
    if (p.type === 'hour') hour = parseInt(p.value, 10);
    else if (p.type === 'minute') minute = parseInt(p.value, 10);
    else if (p.type === 'second') second = parseInt(p.value, 10);
  }
  return { secondsOfDay: hour * 3600 + minute * 60 + second, hour, minute, second };
}

/** Format a UTC epoch (ms) as a readable string in the given timezone. */
export function formatInZone(ms: number | null | undefined, timeZone: string): string {
  if (ms == null) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).format(new Date(ms));
}

/** ISO-8601 UTC string, or '' for null/undefined. */
export function toIso(ms: number | null | undefined): string {
  return ms == null ? '' : new Date(ms).toISOString();
}
