export type OAuthProvider = 'google' | 'facebook' | 'apple';

export type OAuthProviderStatus = {
  enabled: boolean;
  configured: boolean;
  available: boolean;
};

type EnvSource = NodeJS.ProcessEnv;

export function parseOAuthEnabledFlag(
  rawValue: string | undefined,
  defaultEnabled = true,
): boolean {
  if (rawValue === undefined || rawValue.trim() === '') {
    return defaultEnabled;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }

  return (
    normalized === 'true' || normalized === '1' || normalized === 'yes'
  );
}

function readEnv(env: EnvSource, key: string): string | undefined {
  const value = env[key];
  return typeof value === 'string' ? value.trim() : undefined;
}

export function isGoogleLoginEnabled(env: EnvSource = process.env): boolean {
  return parseOAuthEnabledFlag(readEnv(env, 'ENABLE_GOOGLE_LOGIN'));
}

export function isFacebookLoginEnabled(env: EnvSource = process.env): boolean {
  return parseOAuthEnabledFlag(readEnv(env, 'ENABLE_FACEBOOK_LOGIN'));
}

export function isAppleLoginEnabled(env: EnvSource = process.env): boolean {
  return parseOAuthEnabledFlag(readEnv(env, 'ENABLE_APPLE_LOGIN'));
}

export function isGoogleLoginConfigured(env: EnvSource = process.env): boolean {
  return Boolean(
    readEnv(env, 'GOOGLE_CLIENT_ID') &&
      readEnv(env, 'GOOGLE_CLIENT_SECRET') &&
      readEnv(env, 'GOOGLE_CALLBACK_URL'),
  );
}

export function isFacebookLoginConfigured(env: EnvSource = process.env): boolean {
  return Boolean(
    readEnv(env, 'FACEBOOK_APP_ID') &&
      readEnv(env, 'FACEBOOK_APP_SECRET') &&
      readEnv(env, 'FACEBOOK_CALLBACK_URL'),
  );
}

export function isAppleLoginConfigured(env: EnvSource = process.env): boolean {
  const hasPrivateKey = Boolean(
    readEnv(env, 'APPLE_PRIVATE_KEY') ||
      readEnv(env, 'APPLE_PRIVATE_KEY_LOCATION'),
  );

  return Boolean(
    readEnv(env, 'APPLE_CLIENT_ID') &&
      readEnv(env, 'APPLE_TEAM_ID') &&
      readEnv(env, 'APPLE_KEY_ID') &&
      readEnv(env, 'APPLE_CALLBACK_URL') &&
      hasPrivateKey,
  );
}

export function getOAuthProviderStatus(
  provider: OAuthProvider,
  env: EnvSource = process.env,
): OAuthProviderStatus {
  const statusByProvider: Record<
    OAuthProvider,
    { enabled: boolean; configured: boolean }
  > = {
    google: {
      enabled: isGoogleLoginEnabled(env),
      configured: isGoogleLoginConfigured(env),
    },
    facebook: {
      enabled: isFacebookLoginEnabled(env),
      configured: isFacebookLoginConfigured(env),
    },
    apple: {
      enabled: isAppleLoginEnabled(env),
      configured: isAppleLoginConfigured(env),
    },
  };

  const status = statusByProvider[provider];

  return {
    ...status,
    available: status.enabled && status.configured,
  };
}

export function shouldRegisterOAuthStrategy(
  provider: OAuthProvider,
  env: EnvSource = process.env,
): boolean {
  return getOAuthProviderStatus(provider, env).available;
}

export function getAllOAuthProviderStatuses(
  env: EnvSource = process.env,
): Record<OAuthProvider, OAuthProviderStatus> {
  return {
    google: getOAuthProviderStatus('google', env),
    facebook: getOAuthProviderStatus('facebook', env),
    apple: getOAuthProviderStatus('apple', env),
  };
}
