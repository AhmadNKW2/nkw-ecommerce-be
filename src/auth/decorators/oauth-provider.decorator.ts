import { SetMetadata } from '@nestjs/common';
import type { OAuthProvider } from '../oauth-providers.config';

export const OAUTH_PROVIDER_KEY = 'oauth_provider';

export const OAuthProviderRoute = (provider: OAuthProvider) =>
  SetMetadata(OAUTH_PROVIDER_KEY, provider);
