import type { Request as ExpressRequest } from 'express';

const AUTH_ROUTE_PATHS = new Set(['/login', '/register']);

function getStringValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }

  return undefined;
}

function getPathnameOnly(href: string): string {
  return href.split('?')[0]?.split('#')[0] ?? href;
}

export function normalizeOAuthReturnTo(value: unknown): string | undefined {
  const candidate = getStringValue(value)?.trim();

  if (!candidate || !candidate.startsWith('/') || candidate.startsWith('//')) {
    return undefined;
  }

  if (AUTH_ROUTE_PATHS.has(getPathnameOnly(candidate))) {
    return undefined;
  }

  return candidate;
}

export function getOAuthStateFromRequest(
  req: ExpressRequest,
): string | undefined {
  return normalizeOAuthReturnTo(req.query?.returnTo);
}

export function getOAuthReturnToFromRequest(
  req: ExpressRequest,
): string | undefined {
  return (
    normalizeOAuthReturnTo(req.query?.state) ??
    normalizeOAuthReturnTo(req.body?.state) ??
    normalizeOAuthReturnTo(req.query?.returnTo)
  );
}

export function buildFrontendRedirectUrl(
  frontendBaseUrl: string,
  returnTo?: string,
): string {
  const safeReturnTo = normalizeOAuthReturnTo(returnTo);
  const redirectUrl = safeReturnTo
    ? new URL(safeReturnTo, frontendBaseUrl)
    : new URL(frontendBaseUrl);

  // Hint for the storefront to fetch /auth/profile after OAuth without probing on every guest visit.
  redirectUrl.searchParams.set('auth', 'success');

  return redirectUrl.toString();
}

export function buildFrontendLoginUrl(
  frontendBaseUrl: string,
  options?: {
    error?: string;
    returnTo?: string;
  },
): string {
  const loginUrl = new URL('/login', frontendBaseUrl);
  const safeReturnTo = normalizeOAuthReturnTo(options?.returnTo);

  if (options?.error) {
    loginUrl.searchParams.set('error', options.error);
  }

  if (safeReturnTo) {
    loginUrl.searchParams.set('returnTo', safeReturnTo);
  }

  return loginUrl.toString();
}