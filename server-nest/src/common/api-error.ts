import { HttpException } from '@nestjs/common';

/** Builds an error response matching the legacy `{ error: { code, message, fields } }` envelope. */
export function apiError(status: number, message: string, code = 'REQUEST_FAILED'): HttpException {
  return new HttpException({ error: { code, message, fields: [] } }, status);
}
