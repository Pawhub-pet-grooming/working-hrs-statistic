import { attendanceLocation } from './attendance-location.util.js';

describe('attendanceLocation', () => {
  it('requires complete finite coordinates and accepts zero coordinates', () => {
    const invalid = [null, {}, { latitude: 1 }, { latitude: 91, longitude: 0 }, { latitude: 0, longitude: 181 }, { latitude: '0', longitude: 0 }, { latitude: NaN, longitude: 0 }];
    for (const value of invalid) expect(attendanceLocation(value, 0, 0)).toBeNull();

    expect(attendanceLocation({ latitude: 0, longitude: 0 }, 0, 0)!.distanceMeters).toBe(0);
  });

  it('prioritizes a saved distance and historical store coordinates', () => {
    expect(attendanceLocation({ latitude: 0, longitude: 0, distanceMeters: 15 }, 20, 20)!.distanceMeters).toBe(15);
    expect(attendanceLocation({ latitude: 0, longitude: 0, shopLatitude: 0, shopLongitude: 0 }, 20, 20)!.distanceMeters).toBe(0);

    const fallback = attendanceLocation({ latitude: 0, longitude: 0 }, '0', '1');
    expect(Math.abs(fallback!.distanceMeters! - 111195)).toBeLessThan(1);

    expect(attendanceLocation({ latitude: 0, longitude: 0 }, null, null)!.distanceMeters).toBeNull();
  });
});
