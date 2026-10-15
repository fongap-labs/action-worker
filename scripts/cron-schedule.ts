import { CliError } from "./runtime-command.ts";

// A five-field cron expression (minute, hour, day-of-month, month, day-of-week), evaluated in UTC.
// Task schedules and deploy schedules share this parser. `subject` names the owner in error
// messages, so each caller keeps its own wording.

export type ParsedCron = {
  fields: string[];
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
};

export const cronPattern = /^[0-9*/,?\- ]{1,128}$/;

function isWildcard(value: string): boolean {
  return value === "*" || value === "?";
}

function parseInteger(
  value: string,
  min: number,
  max: number,
  label: string,
  subject: string
): number {
  if (!/^\d+$/.test(value)) {
    throw new CliError(`${subject} cron ${label} is invalid.`, 65);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new CliError(`${subject} cron ${label} is out of range.`, 65);
  }
  return parsed;
}

function fieldValues(
  field: string,
  min: number,
  max: number,
  label: string,
  subject: string,
  isSundaySevenAllowed = false
): Set<number> {
  if (!field || !cronPattern.test(field)) {
    throw new CliError(`${subject} cron ${label} is invalid.`, 65);
  }

  const values = new Set<number>();
  for (const rawPart of field.split(",")) {
    if (!rawPart) {
      throw new CliError(`${subject} cron ${label} is invalid.`, 65);
    }
    const segments = rawPart.split("/");
    if (segments.length > 2) {
      throw new CliError(`${subject} cron ${label} step is invalid.`, 65);
    }
    const base = segments[0]!;
    const step =
      segments.length === 2
        ? parseInteger(segments[1]!, 1, max - min + 1, `${label} step`, subject)
        : 1;

    let start = min;
    let end = max;
    if (!isWildcard(base)) {
      const range = base.split("-");
      if (range.length > 2) {
        throw new CliError(`${subject} cron ${label} range is invalid.`, 65);
      }
      if (range.length === 2) {
        start = parseInteger(range[0]!, min, isSundaySevenAllowed ? max + 1 : max, label, subject);
        end = parseInteger(range[1]!, min, isSundaySevenAllowed ? max + 1 : max, label, subject);
        if (start > end) {
          throw new CliError(`${subject} cron ${label} range is reversed.`, 65);
        }
      } else {
        start = parseInteger(base, min, isSundaySevenAllowed ? max + 1 : max, label, subject);
        end = segments.length === 2 ? max : start;
      }
    }

    for (let value = start; value <= end; value += step) {
      values.add(isSundaySevenAllowed && value === 7 ? 0 : value);
    }
  }
  return values;
}

export function parseCronSchedule(cron: string, subject: string): ParsedCron {
  if (!cronPattern.test(cron)) {
    throw new CliError(`${subject} cron is invalid.`, 65);
  }
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CliError(`${subject} cron must contain five fields.`, 65);
  }
  return {
    fields,
    minute: fieldValues(fields[0]!, 0, 59, "minute", subject),
    hour: fieldValues(fields[1]!, 0, 23, "hour", subject),
    day: fieldValues(fields[2]!, 1, 31, "day-of-month", subject),
    month: fieldValues(fields[3]!, 1, 12, "month", subject),
    weekday: fieldValues(fields[4]!, 0, 6, "day-of-week", subject, true),
  };
}

function matchesParsedCron(date: Date, parsed: ParsedCron): boolean {
  if (
    !parsed.minute.has(date.getUTCMinutes()) ||
    !parsed.hour.has(date.getUTCHours()) ||
    !parsed.month.has(date.getUTCMonth() + 1)
  ) {
    return false;
  }

  const dayMatch = parsed.day.has(date.getUTCDate());
  const weekdayMatch = parsed.weekday.has(date.getUTCDay());
  const dayWildcard = isWildcard(parsed.fields[2]!);
  const weekdayWildcard = isWildcard(parsed.fields[4]!);

  if (dayWildcard && weekdayWildcard) return true;
  if (dayWildcard) return weekdayMatch;
  if (weekdayWildcard) return dayMatch;
  return dayMatch || weekdayMatch;
}

export function cronMatches(date: Date, cron: string, subject: string): boolean {
  if (Number.isNaN(date.getTime())) {
    throw new CliError(`${subject} schedule time is invalid.`, 64);
  }
  return matchesParsedCron(date, parseCronSchedule(cron, subject));
}

export function minuteFloor(value: Date): Date {
  const date = new Date(value);
  date.setUTCSeconds(0, 0);
  return date;
}

// A slot is the UTC minute at which a cron fires, written as a string that sorts by time.
export function slotKey(value: Date): string {
  return `${value.toISOString().slice(0, 16)}Z`;
}

/**
 * The most recent minute, at or before `now`, that the schedule fires at, looking back at most
 * `lookbackMinutes` minutes. Null when no firing falls in that window.
 */
export function latestCronSlot(
  parsed: ParsedCron,
  now: Date,
  lookbackMinutes: number
): Date | null {
  const current = minuteFloor(now);
  for (let offset = 0; offset < lookbackMinutes; offset += 1) {
    const candidate = new Date(current.getTime() - offset * 60_000);
    if (matchesParsedCron(candidate, parsed)) {
      return candidate;
    }
  }
  return null;
}
