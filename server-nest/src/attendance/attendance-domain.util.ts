import { DateTime } from 'luxon';
import { apiError } from '../common/api-error.js';

/** Mirrors legacy's `server/src/domain.js`. */
export const ATTENDANCE_ZONE = 'Pacific/Auckland';

export interface MonthBounds {
  month: string;
  timezone: string;
  start: string;
  end: string;
  fromDate: string;
  toDate: string;
}

export function monthBounds(month: string | undefined): MonthBounds {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month ?? '')) throw apiError(422, 'Month must be YYYY-MM');

  const start = DateTime.fromISO(`${month}-01`, { zone: ATTENDANCE_ZONE });
  if (!start.isValid) throw apiError(422, 'Invalid month');

  return {
    month: month as string,
    timezone: ATTENDANCE_ZONE,
    start: start.toUTC().toISO() as string,
    end: start.plus({ months: 1 }).toUTC().toISO() as string,
    fromDate: start.toISODate() as string,
    toDate: start.endOf('month').toISODate() as string,
  };
}

export function localDate(instant: Date | string): string {
  return DateTime.fromJSDate(new Date(instant), { zone: ATTENDANCE_ZONE }).toISODate() as string;
}
