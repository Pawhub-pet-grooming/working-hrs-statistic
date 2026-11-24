import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { apiError } from '../common/api-error.js';
import type { Env } from '../config/env.schema.js';

export interface Coordinates {
  latitude: number;
  longitude: number;
}

interface CacheEntry {
  coordinates: Coordinates;
  expires: number;
}

/** Mirrors legacy's `geocodeAddress()` (server/src/geocode.js): a Photon-compatible lookup with a 24h in-memory cache. */
@Injectable()
export class GeocodeService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly config: ConfigService<Env, true>) {}

  async geocodeAddress(address: string): Promise<Coordinates> {
    const url = new URL(this.config.get('GEOCODING_URL', { infer: true }) ?? 'https://photon.komoot.io/api/');
    url.searchParams.set('q', address.trim());
    url.searchParams.set('limit', '1');
    const key = url.toString();

    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.coordinates;

    let data: { features?: unknown };
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'Pawhub/1.0' },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error('Geocoder unavailable');
      data = await response.json();
      if (!Array.isArray(data.features)) throw new Error('Invalid geocoder response');
    } catch {
      throw apiError(503, 'Address lookup is unavailable. Please try again later.', 'GEOCODING_UNAVAILABLE');
    }

    const features = data.features as unknown[];
    if (!features.length) {
      throw apiError(422, 'Address not found. Include the street number, city and country.', 'ADDRESS_NOT_FOUND');
    }

    const geometry = (features[0] as { geometry?: { type?: string; coordinates?: unknown } } | undefined)?.geometry;
    const [longitude, latitude] = Array.isArray(geometry?.coordinates) ? geometry.coordinates : [];
    if (
      geometry?.type !== 'Point' ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    ) {
      throw apiError(
        503,
        'Address lookup returned an invalid location. Please try again later.',
        'GEOCODING_UNAVAILABLE',
      );
    }

    const coordinates = { latitude, longitude };
    if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key, { coordinates, expires: Date.now() + 86_400_000 });
    return coordinates;
  }
}
