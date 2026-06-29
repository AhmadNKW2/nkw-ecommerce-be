import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OAUTH_PROVIDER_KEY } from '../decorators/oauth-provider.decorator';
import {
  OAuthProvider,
  getOAuthProviderStatus,
} from '../oauth-providers.config';

@Injectable()
export class OAuthProviderEnabledGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const provider = this.reflector.getAllAndOverride<OAuthProvider | undefined>(
      OAUTH_PROVIDER_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!provider) {
      return true;
    }

    const status = getOAuthProviderStatus(provider, process.env);

    if (!status.enabled) {
      throw new NotFoundException(`${provider} login is disabled`);
    }

    if (!status.configured) {
      throw new NotFoundException(`${provider} login is not configured`);
    }

    return true;
  }
}
