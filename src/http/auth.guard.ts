import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';

/**
 * Authentication extension point (auth is optional in the challenge and was
 * deliberately left out, see ARCHITECTURE.md).
 *
 * To plug an external identity provider (Keycloak, Zitadel...): validate the
 * bearer JWT here against the provider's JWKS, keep /health/* open, and map
 * the token's client to the allowed `provider` values so a caller can only
 * submit transactions for its own provider.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
