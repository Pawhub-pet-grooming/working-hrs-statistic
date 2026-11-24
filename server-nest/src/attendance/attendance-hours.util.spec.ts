import { dailyAttendanceHours, totalAttendanceHours, type AttendanceHoursRecord } from './attendance-hours.util.js';

const r = (
  id: string,
  time: string,
  type: string,
  extra: Partial<AttendanceHoursRecord> = {},
): AttendanceHoursRecord => ({
  id,
  effective_occurred_at: `2026-10-26T${time}:00+13:00`,
  sign_type: type,
  ...extra,
});

describe('dailyAttendanceHours', () => {
  it('sorts, pairs, rounds each pair and sums integer hundredths', () => {
    const rows = [
      r('d', '10:02', 'SIGN_OUT'),
      r('b', '09:01', 'SIGN_OUT'),
      r('c', '10:00', 'SIGN_IN'),
      r('a', '09:00', 'SIGN_IN'),
    ];

    expect(dailyAttendanceHours(rows)).toEqual([
      { date: '2026-10-26', valid: true, hours: '0.05', pending: false, recordCount: 4 },
    ]);
  });

  it('shows adjustment required without a partial total for malformed sequences', () => {
    const cases = [
      [r('a', '09:00', 'SIGN_IN')],
      [r('a', '09:00', 'SIGN_OUT'), r('b', '10:00', 'SIGN_IN')],
      [r('a', '09:00', 'SIGN_IN'), r('b', '10:00', 'SIGN_IN')],
    ];

    for (const rows of cases) {
      const [day] = dailyAttendanceHours(rows);
      expect(day!.valid).toBe(false);
      expect(day!.hours).toBeNull();
    }
  });

  it('uses the latest pending type/time and excludes removals', () => {
    const rows = [
      r('a', '09:00', 'SIGN_OUT', { pending_sign_type: 'SIGN_IN', pending: true }),
      r('b', '17:30', 'SIGN_OUT'),
      r('c', '18:00', 'SIGN_IN', { effective_deleted: true, pending: true }),
    ];

    expect(dailyAttendanceHours(rows)[0]!.hours).toBe('8.50');
    expect(dailyAttendanceHours(rows)[0]!.pending).toBe(true);
  });

  it('keeps Auckland dates separate and uses elapsed time across a DST boundary', () => {
    const rows: AttendanceHoursRecord[] = [
      { id: 'a', effective_occurred_at: '2026-09-27T01:30:00+12:00', sign_type: 'SIGN_IN' },
      { id: 'b', effective_occurred_at: '2026-09-27T03:30:00+13:00', sign_type: 'SIGN_OUT' },
      r('c', '09:00', 'SIGN_IN'),
    ];

    const days = dailyAttendanceHours(rows);
    expect(days[0]!.hours).toBe('1.00');
    expect(days[1]!.valid).toBe(false);
  });

  it('gives zero hours for a matching zero-duration pair', () => {
    expect(dailyAttendanceHours([r('a', '09:00', 'SIGN_IN'), r('b', '09:00', 'SIGN_OUT')])[0]!.hours).toBe('0.00');
  });

  it('pairs within each store and adds daily hours across stores', () => {
    const rows = [
      r('a', '09:00', 'SIGN_IN', { shop_id: 'A' }),
      r('b', '10:00', 'SIGN_OUT', { shop_id: 'A' }),
      r('c', '11:00', 'SIGN_IN', { shop_id: 'B' }),
      r('d', '13:30', 'SIGN_OUT', { shop_id: 'B' }),
    ];

    expect(dailyAttendanceHours(rows)[0]!.hours).toBe('3.50');
    expect(dailyAttendanceHours([rows[0]!, rows[3]!])[0]!.valid).toBe(false);
  });
});

describe('totalAttendanceHours', () => {
  it('includes valid pending days and flags any invalid day', () => {
    const days = [
      { date: 'x', valid: true, hours: '8.33', pending: false },
      { date: 'y', valid: true, hours: '7.67', pending: true },
    ];

    expect(totalAttendanceHours(days)).toEqual({ valid: true, hours: '16.00', pending: true });
    expect(totalAttendanceHours([...days, { date: 'z', valid: false, hours: null, pending: false }])).toEqual({
      valid: false,
      hours: null,
      pending: true,
    });
    expect(totalAttendanceHours([])).toEqual({ valid: true, hours: '0.00', pending: false });
  });
});
