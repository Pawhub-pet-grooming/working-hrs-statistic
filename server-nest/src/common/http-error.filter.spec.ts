import { ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { HttpErrorFilter } from './http-error.filter.js';

function hostWithResponse(): { host: ArgumentsHost; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const host = { switchToHttp: () => ({ getResponse: () => ({ status }) }) } as unknown as ArgumentsHost;

  return { host, status, json };
}

describe('HttpErrorFilter', () => {
  let filter: HttpErrorFilter;
  const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

  beforeEach(() => {
    filter = new HttpErrorFilter();
    error.mockClear();
  });

  it('passes an HttpException straight through with its own status and body', () => {
    const { host, status, json } = hostWithResponse();
    const exception = new HttpException({ error: { code: 'VALIDATION_ERROR', message: 'bad', fields: [] } }, 422);

    filter.catch(exception, host);

    expect(status).toHaveBeenCalledWith(422);
    expect(json).toHaveBeenCalledWith({ error: { code: 'VALIDATION_ERROR', message: 'bad', fields: [] } });
    expect(error).not.toHaveBeenCalled();
  });

  it('maps any other thrown value to a generic 500 and logs it', () => {
    const { host, status, json } = hostWithResponse();

    filter.catch(new Error('unexpected'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', fields: [] },
    });
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('logs a non-Error thrown value as-is rather than its (nonexistent) stack', () => {
    const { host } = hostWithResponse();

    filter.catch('a plain string throw', host);

    expect(error).toHaveBeenCalledWith('a plain string throw');
  });
});
