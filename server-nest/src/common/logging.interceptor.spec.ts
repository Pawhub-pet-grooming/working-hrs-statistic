import { Logger, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { LoggingInterceptor } from './logging.interceptor.js';

function contextWithRequest(method: string, originalUrl: string, statusCode: number): ExecutionContext {
  const request = { method, originalUrl };
  const response = { statusCode };

  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ExecutionContext;
}

function handlerReturning(result: unknown, isError: boolean): CallHandler {
  return { handle: () => (isError ? throwError(() => result) : of(result)) } as unknown as CallHandler;
}

describe('LoggingInterceptor', () => {
  let interceptor: LoggingInterceptor;
  const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

  beforeEach(() => {
    interceptor = new LoggingInterceptor();
    log.mockClear();
    warn.mockClear();
  });

  it('logs the method, URL and response status on success', async () => {
    const context = contextWithRequest('GET', '/api/v1/me', 200);

    await lastValueFrom(interceptor.intercept(context, handlerReturning({ ok: true }, false)));

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/^GET \/api\/v1\/me 200 \d+ms$/);
  });

  it('warns with the error message instead of logging a success line when the handler throws', async () => {
    const context = contextWithRequest('POST', '/api/v1/attendance', 0);

    await expect(lastValueFrom(interceptor.intercept(context, handlerReturning(new Error('boom'), true)))).rejects.toThrow('boom');

    expect(log).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/^POST \/api\/v1\/attendance failed after \d+ms: boom$/);
  });

  it('stringifies a non-Error throw rather than crashing the logger', async () => {
    const context = contextWithRequest('POST', '/api/v1/attendance', 0);

    await expect(lastValueFrom(interceptor.intercept(context, handlerReturning('not an Error', true)))).rejects.toBe('not an Error');

    expect(warn.mock.calls[0]![0]).toMatch(/failed after \d+ms: not an Error$/);
  });
});
