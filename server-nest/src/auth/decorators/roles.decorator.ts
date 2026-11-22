import { SetMetadata } from '@nestjs/common';
import type { Role } from '../types.js';

export const ROLES_KEY = 'roles';

/** Replaces legacy's static role-list checks (e.g. `backend.includes(role)`, `companyAdmin()`). */
export const Roles = (...roles: Role[]): ReturnType<typeof SetMetadata> => SetMetadata(ROLES_KEY, roles);
