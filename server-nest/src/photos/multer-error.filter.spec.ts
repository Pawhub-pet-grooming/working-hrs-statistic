import { ArgumentsHost } from '@nestjs/common';
import { MulterError } from 'multer';
import { MulterErrorFilter } from './multer-error.filter.js';

describe('MulterErrorFilter', () => {
  let filter: MulterErrorFilter;

  beforeEach(() => {
    filter = new MulterErrorFilter();
  });

  it('maps a MulterError to 413 with its code and message', () => {
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    const host = { switchToHttp: () => ({ getResponse: () => ({ status }) }) } as unknown as ArgumentsHost;
    const exception = new MulterError('LIMIT_FILE_SIZE', 'file');

    filter.catch(exception, host);

    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith({ error: { code: 'LIMIT_FILE_SIZE', message: exception.message, fields: [] } });
  });
});
