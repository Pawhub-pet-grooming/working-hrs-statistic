export interface AttendanceLocationInput {
  latitude?: unknown;
  longitude?: unknown;
  distanceMeters?: unknown;
  shopLatitude?: unknown;
  shopLongitude?: unknown;
  accuracyMeters?: unknown;
  capturedAt?: unknown;
}

export interface AttendanceLocationResult {
  latitude: number;
  longitude: number;
  distanceMeters: number | null;
  accuracyMeters: number | null;
  capturedAt: unknown;
}

function isCoordinate(value: unknown, limit: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;
}

/** Mirrors legacy's `attendanceLocation` (server/src/attendance-location.js). */
export function attendanceLocation(
  location: AttendanceLocationInput | null | undefined,
  shopLatitude: unknown,
  shopLongitude: unknown,
): AttendanceLocationResult | null {
  if (!location || !isCoordinate(location.latitude, 90) || !isCoordinate(location.longitude, 180)) return null;

  const distanceMeters = resolveDistance(location, shopLatitude, shopLongitude);

  return {
    latitude: location.latitude,
    longitude: location.longitude,
    distanceMeters,
    accuracyMeters:
      isCoordinate(location.accuracyMeters, Infinity) && (location.accuracyMeters as number) >= 0
        ? (location.accuracyMeters as number)
        : null,
    capturedAt: location.capturedAt ?? null,
  };
}

function resolveDistance(
  location: AttendanceLocationInput,
  shopLatitude: unknown,
  shopLongitude: unknown,
): number | null {
  if (
    typeof location.distanceMeters === 'number' &&
    Number.isFinite(location.distanceMeters) &&
    location.distanceMeters >= 0
  ) {
    return location.distanceMeters;
  }

  const lat = isCoordinate(location.shopLatitude, 90)
    ? location.shopLatitude
    : shopLatitude == null
      ? null
      : Number(shopLatitude);
  const lon = isCoordinate(location.shopLongitude, 180)
    ? location.shopLongitude
    : shopLongitude == null
      ? null
      : Number(shopLongitude);
  if (!isCoordinate(lat, 90) || !isCoordinate(lon, 180)) return null;

  return haversineMeters(lat, lon, location.latitude as number, location.longitude as number);
}

function haversineMeters(lat: number, lon: number, latitude: number, longitude: number): number {
  const rad = (value: number): number => (value * Math.PI) / 180;
  const h =
    Math.sin(rad(lat - latitude) / 2) ** 2 +
    Math.cos(rad(latitude)) * Math.cos(rad(lat)) * Math.sin(rad(lon - longitude) / 2) ** 2;

  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}
