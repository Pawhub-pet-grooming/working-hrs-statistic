import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { MulterError } from 'multer';
import type { Response } from 'express';

/** Mirrors legacy's error middleware: `err instanceof multer.MulterError` → 413 (e.g. file too large). */
@Catch(MulterError)
export class MulterErrorFilter implements ExceptionFilter {
  catch(exception: MulterError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    res.status(413).json({ error: { code: exception.code, message: exception.message, fields: [] } });
  }
}
