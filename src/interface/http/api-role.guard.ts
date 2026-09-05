import { type CanActivate, Inject, Injectable } from '@nestjs/common';

import { ApplicationError, ErrorCode } from '@/application/errors';
import type { AppEnv } from '@/bootstrap/env';
import { APP_ENV } from '@/infrastructure/tokens';

// Every role serves the operational surface — health and metrics — because a
// consumer or publisher that no one can scrape produces metrics nobody reads.
// The business API stays exclusive to the api role, and answers 404 without it.
@Injectable()
export class ApiRoleGuard implements CanActivate {
  constructor(@Inject(APP_ENV) private readonly env: AppEnv) {}

  canActivate(): boolean {
    if (!this.env.roles.includes('api')) {
      throw new ApplicationError(
        ErrorCode.ResourceNotFound,
        'the api role is not enabled on this instance',
      );
    }
    return true;
  }
}
