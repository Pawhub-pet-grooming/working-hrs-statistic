import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpException } from '@nestjs/common';
import { GeocodeService } from './geocode.service.js';

describe('GeocodeService', () => {
  let service: GeocodeService;
  const config = { get: vi.fn().mockReturnValue(undefined) } as unknown as ConfigService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [GeocodeService, { provide: ConfigService, useValue: config }],
    }).compile();
    service = module.get(GeocodeService);
  });

  it('resolves an address and reuses cached coordinates without a second fetch', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      expect((url as URL).searchParams.get('q')).toBe('123 Example Street, Auckland, New Zealand');
      expect((url as URL).searchParams.get('limit')).toBe('1');
      return {
        ok: true,
        json: async () => ({ features: [{ geometry: { type: 'Point', coordinates: [174.76, -36.85] } }] }),
      } as Response;
    });

    const address = '123 Example Street, Auckland, New Zealand';
    await expect(service.geocodeAddress(address)).resolves.toEqual({ latitude: -36.85, longitude: 174.76 });
    await service.geocodeAddress(address);

    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockRestore();
  });

  it.each([
    ['no matches', { features: [] }, 422, 'ADDRESS_NOT_FOUND'],
    ['invalid response', {}, 503, 'GEOCODING_UNAVAILABLE'],
    [
      'invalid coordinates',
      { features: [{ geometry: { type: 'Point', coordinates: [999, null] } }] },
      503,
      'GEOCODING_UNAVAILABLE',
    ],
  ])('rejects on %s', async (name, response, status, code) => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, json: async () => response } as Response);

    const promise = service.geocodeAddress(name as string);
    await expect(promise).rejects.toBeInstanceOf(HttpException);
    await expect(promise).rejects.toMatchObject({ status, response: { error: { code } } });
    fetchMock.mockRestore();
  });

  it('rejects with GEOCODING_UNAVAILABLE on a provider error', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false } as Response);
    const promise = service.geocodeAddress('provider error');
    await expect(promise).rejects.toMatchObject({
      status: 503,
      response: { error: { code: 'GEOCODING_UNAVAILABLE' } },
    });
    fetchMock.mockRestore();
  });

  it('rejects with GEOCODING_UNAVAILABLE on a timeout', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('Timed out', 'TimeoutError'));
    const promise = service.geocodeAddress('timeout');
    await expect(promise).rejects.toMatchObject({
      status: 503,
      response: { error: { code: 'GEOCODING_UNAVAILABLE' } },
    });
    fetchMock.mockRestore();
  });
});
