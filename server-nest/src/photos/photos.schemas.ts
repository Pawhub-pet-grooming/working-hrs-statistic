import { z } from 'zod';

export const uploadPhotoSchema = z.object({ operationId: z.string().uuid() });
export type UploadPhotoDto = z.infer<typeof uploadPhotoSchema>;

export const photoIdParamSchema = z.string().uuid();
