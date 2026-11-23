import { DateTime } from 'luxon';
import { ATTENDANCE_ZONE } from './attendance-domain.util.js';

export interface AttendanceHoursRecord {
  id: string;
  effective_occurred_at: Date | string;
  sign_type: string;
  shop_id?: string | null;
  effective_deleted?: boolean;
  confirmed_deleted?: boolean;
  pending?: boolean;
  pending_sign_type?: string | null;
}

export interface DailyHours {
  date: string;
  valid: boolean;
  hours: string | null;
  pending: boolean;
  recordCount: number;
}

export interface TotalHours {
  valid: boolean;
  hours: string | null;
  pending: boolean;
}

/** Mirrors legacy's `dailyAttendanceHours` (server/src/attendance-hours.js). Each pair is rounded to integer hundredths before totals are added. */
export function dailyAttendanceHours(records: AttendanceHoursRecord[]): DailyHours[] {
  const days = groupByLocalDate(records);

  return [...days]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, rows]) => buildDailyHours(date, rows));
}

/** Mirrors legacy's `totalAttendanceHours`. */
export function totalAttendanceHours(days: DailyHours[]): TotalHours {
  const valid = days.every((day) => day.valid);

  const hundredths = days.reduce((sum, day) => sum + (day.valid ? Math.round(Number(day.hours) * 100) : 0), 0);

  return { valid, hours: valid ? (hundredths / 100).toFixed(2) : null, pending: days.some((day) => day.pending) };
}

function groupByLocalDate(records: AttendanceHoursRecord[]): Map<string, { record: AttendanceHoursRecord; time: number }[]> {
  const days = new Map<string, { record: AttendanceHoursRecord; time: number }[]>();

  for (const record of records) {
    const time = DateTime.fromISO(
      String(record.effective_occurred_at instanceof Date ? record.effective_occurred_at.toISOString() : record.effective_occurred_at),
      { zone: ATTENDANCE_ZONE },
    );
    const date = time.isValid ? (time.toISODate() as string) : 'Invalid date';

    if (!days.has(date)) days.set(date, []);
    days.get(date)!.push({ record, time: time.toMillis() });
  }

  return days;
}

function buildDailyHours(date: string, rows: { record: AttendanceHoursRecord; time: number }[]): DailyHours {
  const active = rows
    .filter(({ record }) => !record.effective_deleted && !record.confirmed_deleted)
    .sort((a, b) => a.time - b.time || String(a.record.id).localeCompare(String(b.record.id)));

  const stores = new Map<string, { record: AttendanceHoursRecord; time: number }[]>();
  for (const row of active) {
    const key = row.record.shop_id ?? 'single';
    if (!stores.has(key)) stores.set(key, []);
    stores.get(key)!.push(row);
  }

  let valid = true;
  let hundredths = 0;

  for (const entries of stores.values()) {
    if (entries.length % 2 !== 0) valid = false;

    for (let i = 0; i < entries.length; i += 2) {
      const start = entries[i]!;
      const end = entries[i + 1];
      if (
        !end ||
        !Number.isFinite(start.time) ||
        !Number.isFinite(end.time) ||
        end.time < start.time ||
        (start.record.pending_sign_type || start.record.sign_type) !== 'SIGN_IN' ||
        (end.record.pending_sign_type || end.record.sign_type) !== 'SIGN_OUT'
      ) {
        valid = false;
        break;
      }
      hundredths += Math.round((end.time - start.time) / 36000);
    }
  }

  return {
    date,
    valid,
    hours: valid ? (hundredths / 100).toFixed(2) : null,
    pending: rows.some(({ record }) => record.pending ?? false),
    recordCount: active.length,
  };
}
