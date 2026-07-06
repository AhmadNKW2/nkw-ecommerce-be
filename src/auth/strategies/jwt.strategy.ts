import {
  Injectable,
  UnauthorizedException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { AuthService, TokenPayload } from '../auth.service';

const decodeJwtPayload = (token: string): { exp?: number } | null => {
  try {
    const segment = token.split('.')[1];
    if (!segment) return null;
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(normalized, 'base64').toString('utf8');
    return JSON.parse(json) as { exp?: number };
  } catch {
    return null;
  }
};

const isJwtExpired = (token: string): boolean => {
  const payload = decodeJwtPayload(token);
  if (!payload?.exp) return false;
  return payload.exp <= Math.floor(Date.now() / 1000);
};

/**
 * Custom extractor that tries to get the JWT from:
 * 1. Authorization header as Bearer token (unless expired)
 * 2. HTTP-only cookie named 'access_token' (fallback for browser auth)
 */
const cookieOrBearerExtractor = (req: Request): string | null => {
  const authHeader = req.headers.authorization;
  const bearerToken =
    authHeader && authHeader.startsWith('Bearer ')
      ? authHeader.substring(7)
      : null;

  const cookieToken =
    req.cookies && req.cookies.access_token
      ? (req.cookies.access_token as string)
      : null;

  if (bearerToken && !isJwtExpired(bearerToken)) {
    return bearerToken;
  }

  if (cookieToken) {
    return cookieToken;
  }

  return bearerToken;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    @Inject(forwardRef(() => AuthService))
    private authService: AuthService,
  ) {
    super({
      jwtFromRequest: cookieOrBearerExtractor,
      ignoreExpiration: false,
      secretOrKey:
        configService.get('JWT_SECRET') ||
        'your-secret-key-change-in-production',
    });
  }

  async validate(payload: TokenPayload) {
    // Ensure this is an access token, not a refresh token
    if (
      payload.type &&
      payload.type !== 'access' &&
      payload.type !== 'static_access'
    ) {
      throw new UnauthorizedException('Invalid token type');
    }

    try {
      // Validate token (checks blacklist and user status)
      const user = await this.authService.validateToken(payload);
      return user; // This will be available as req.user in controllers
    } catch (error) {
      // Token might be expired, blacklisted, or user no longer exists
      throw new UnauthorizedException(
        'Token validation failed. Please login again.',
      );
    }
  }
}
