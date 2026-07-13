import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { UsersService } from '../users/users.service';
import { UserRole } from '../users/entities/user.entity';
import { VendorsService } from '../vendors/vendors.service';
import { VendorStatus } from '../vendors/entities/vendor.entity';
import { resolveAdminAccess } from '../users/utils/admin-access.util';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { PasswordResetToken } from './entities/password-reset-token.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { TokenBlacklist } from './entities/token-blacklist.entity';
import * as crypto from 'crypto';

export interface TokenPayload {
  sub: number;
  email: string;
  role: string;
  jti: string;
  type: 'access' | 'refresh' | 'static_access';
  authSource?: 'user' | 'vendor';
  vendorId?: number;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiry: Date;
  refreshTokenExpiry: Date;
  accessTokenExpiresInSeconds: number | null;
  isStaticAccessToken: boolean;
}

export interface RequestMetadata {
  userAgent?: string;
  ipAddress?: string;
}

function parsePositiveIntConfig(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

@Injectable()
export class AuthService {
  private readonly accessTokenExpiresIn: number;
  private readonly refreshTokenExpiresIn: number;
  private readonly refreshTokenMaxAge: number;
  private readonly staticAccessTokenCookieMaxAge = 60 * 60 * 24 * 365 * 5;

  constructor(
    private usersService: UsersService,
    private vendorsService: VendorsService,
    private jwtService: JwtService,
    private configService: ConfigService,
    @InjectRepository(PasswordResetToken)
    private passwordResetTokenRepository: Repository<PasswordResetToken>,
    @InjectRepository(RefreshToken)
    private refreshTokenRepository: Repository<RefreshToken>,
    @InjectRepository(TokenBlacklist)
    private tokenBlacklistRepository: Repository<TokenBlacklist>,
  ) {
    // Access token: 60 minutes (in seconds)
    this.accessTokenExpiresIn = parsePositiveIntConfig(
      this.configService.get('ACCESS_TOKEN_EXPIRES_IN'),
      3600,
    );
    // Refresh token: 7 days (in seconds)
    this.refreshTokenExpiresIn = parsePositiveIntConfig(
      this.configService.get('REFRESH_TOKEN_EXPIRES_IN'),
      604800,
    );
    // Max age for refresh token sliding expiration: 30 days (in seconds)
    this.refreshTokenMaxAge = parsePositiveIntConfig(
      this.configService.get('REFRESH_TOKEN_MAX_AGE'),
      2592000,
    );
  }

  private isStaticAccessRole(role: string): boolean {
    return role === UserRole.CONSTANT_TOKEN_ADMIN || role === 'products_api';
  }

  private async resolveStaticAccessToken(
    userId: number,
    accessPayload: TokenPayload,
  ): Promise<string> {
    const storedToken = await this.usersService.getConstantAccessToken(userId);
    if (storedToken) {
      try {
        this.jwtService.verify(storedToken);
        return storedToken;
      } catch {
        // Stored token is invalid or was signed with an old secret — regenerate.
      }
    }

    const accessToken = this.jwtService.sign(accessPayload, {
      expiresIn: this.staticAccessTokenCookieMaxAge,
    });
    await this.usersService.setConstantAccessToken(userId, accessToken);
    return accessToken;
  }

  /**
   * Generate access and refresh tokens
   */
  private async generateTokens(
    userId: number,
    email: string,
    role: string,
    metadata?: RequestMetadata,
    options?: { authSource?: 'user' | 'vendor'; vendorId?: number },
  ): Promise<AuthTokens> {
    const isStaticAccessToken = this.isStaticAccessRole(role);
    const accessTokenJti = isStaticAccessToken
      ? `static-access-${userId}`
      : crypto.randomUUID();
    const refreshTokenJti = crypto.randomUUID();

    const accessTokenExpiry = new Date(
      Date.now() +
        (isStaticAccessToken
          ? this.staticAccessTokenCookieMaxAge
          : this.accessTokenExpiresIn) *
          1000,
    );
    const refreshTokenExpiry = new Date(
      Date.now() + this.refreshTokenExpiresIn * 1000,
    );

    // Generate access token
    const accessPayload: TokenPayload = {
      sub: userId,
      email,
      role,
      jti: accessTokenJti,
      type: isStaticAccessToken ? 'static_access' : 'access',
      authSource: options?.authSource,
      vendorId: options?.vendorId,
    };
    const accessToken = isStaticAccessToken
      ? await this.resolveStaticAccessToken(userId, accessPayload)
      : this.jwtService.sign(accessPayload, {
          expiresIn: this.accessTokenExpiresIn,
        });

    // Generate refresh token
    const refreshPayload: TokenPayload = {
      sub: userId,
      email,
      role,
      jti: refreshTokenJti,
      type: 'refresh',
      authSource: options?.authSource,
      vendorId: options?.vendorId,
    };
    const refreshToken = this.jwtService.sign(refreshPayload, {
      expiresIn: this.refreshTokenExpiresIn,
    });

    // Store refresh token in database
    const refreshTokenEntity = this.refreshTokenRepository.create({
      token: refreshTokenJti,
      userId,
      expiresAt: refreshTokenExpiry,
      userAgent: metadata?.userAgent,
      ipAddress: metadata?.ipAddress,
    });
    await this.refreshTokenRepository.save(refreshTokenEntity);

    return {
      accessToken,
      refreshToken,
      accessTokenExpiry,
      refreshTokenExpiry,
      accessTokenExpiresInSeconds: isStaticAccessToken
        ? null
        : this.accessTokenExpiresIn,
      isStaticAccessToken,
    };
  }

  /**
   * Get cookie options for access token
   * HTTPS context: secure=true, sameSite=none (cross-site fetch is allowed)
   * HTTP context: secure=false, sameSite=lax (local development)
   */
  getCookieOptions(isSecureContext: boolean, isStaticAccessToken = false) {
    const isSecure = isSecureContext;
    const sameSiteValue: 'none' | 'lax' = isSecureContext ? 'none' : 'lax';
    const accessMaxAge =
      (isStaticAccessToken
        ? this.staticAccessTokenCookieMaxAge
        : this.accessTokenExpiresIn) * 1000;

    return {
      access: {
        httpOnly: true,
        secure: isSecure,
        sameSite: sameSiteValue,
        maxAge: accessMaxAge,
        path: '/',
      },
      refresh: {
        httpOnly: true,
        secure: isSecure,
        sameSite: sameSiteValue,
        maxAge: this.refreshTokenExpiresIn * 1000,
        path: '/api/auth', // Only send refresh token to auth endpoints
      },
    };
  }

  /**
   * Access token expiry (seconds) for clients.
   */
  getAccessTokenExpiresInSeconds(): number {
    return this.accessTokenExpiresIn;
  }

  async register(registerDto: RegisterDto, metadata?: RequestMetadata) {
    // Create user with specified role (or default to USER)
    const user = await this.usersService.create(registerDto);

    // Generate tokens
    const tokens = await this.generateTokens(
      user.id,
      user.email,
      user.role,
      metadata,
    );

    return {
      tokens,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
      },
    };
  }

  async googleLogin(user: any, metadata?: RequestMetadata) {
    if (!user) {
      throw new BadRequestException('No user from google');
    }

    let existingUser;

    // 1. Try finding by googleId
    if (user.googleId) {
      existingUser = await this.usersService.findByGoogleId(user.googleId);
    }

    // 2. Fallback to email
    if (!existingUser && user.email) {
      existingUser = await this.usersService.findByEmail(user.email);
    }

    if (!existingUser) {
      // Create user if not exists
      const randomPassword = crypto.randomBytes(16).toString('hex');

      existingUser = await this.usersService.create({
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        password: randomPassword,
        role: UserRole.USER,
        googleId: user.googleId,
        image: user.picture,
      } as any);
    } else {
      // Update googleId or image if changed/missing
      const updates: any = {};
      if (user.googleId && existingUser.googleId !== user.googleId) {
        updates.googleId = user.googleId;
      }
      if (user.picture && existingUser.image !== user.picture) {
        updates.image = user.picture;
      }

      if (Object.keys(updates).length > 0) {
        // We use update method which handles saving
        existingUser = await this.usersService.update(existingUser.id, updates);
      }
    }

    const tokens = await this.generateTokens(
      existingUser.id,
      existingUser.email,
      existingUser.role,
      metadata,
    );

    return {
      tokens,
      user: {
        id: existingUser.id,
        email: existingUser.email,
        firstName: existingUser.firstName,
        lastName: existingUser.lastName,
        role: existingUser.role,
        picture: existingUser.image || user.picture, // Use DB image or google picture
      },
    };
  }

  async facebookLogin(user: any, metadata?: RequestMetadata) {
    if (!user) {
      throw new BadRequestException('No user from facebook');
    }

    // Facebook might not return an email, so we might need to handle that.
    // However, for this implementation we assume email is essential for account linking.
    if (!user.email) {
      throw new BadRequestException('Email is required for login');
    }

    let existingUser = await this.usersService.findByEmail(user.email);

    if (!existingUser) {
      // Create user if not exists
      const randomPassword = crypto.randomBytes(16).toString('hex');

      existingUser = await this.usersService.create({
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        password: randomPassword,
        role: UserRole.USER,
      } as any);
    }

    const tokens = await this.generateTokens(
      existingUser.id,
      existingUser.email,
      existingUser.role,
      metadata,
    );

    return {
      tokens,
      user: {
        id: existingUser.id,
        email: existingUser.email,
        firstName: existingUser.firstName,
        lastName: existingUser.lastName,
        role: existingUser.role,
        picture: user.picture,
      },
    };
  }

  async appleLogin(user: any, metadata?: RequestMetadata) {
    if (!user) {
      throw new BadRequestException('No user from apple');
    }

    let existingUser;

    // First try finding by appleId
    if (user.appleId) {
      existingUser = await this.usersService.findByAppleId(user.appleId);
    }

    // Fallback to email if no user found by appleId (for legacy support or migration)
    if (!existingUser && user.email) {
      existingUser = await this.usersService.findByEmail(user.email);
    }

    if (!existingUser) {
      // If email is hidden (private relay) and we didn't get it
      const email = user.email || `${user.appleId}@privaterelay.appleid.com`;

      const randomPassword = crypto.randomBytes(16).toString('hex');

      existingUser = await this.usersService.create({
        email: email,
        firstName: user.firstName || 'Apple',
        lastName: user.lastName || 'User',
        password: randomPassword,
        role: UserRole.USER,
        appleId: user.appleId, // Save the stable Apple ID!
      } as any);
    } else if (!existingUser.appleId && user.appleId) {
      // Link existing account with Apple ID if not already linked
      await this.usersService.update(existingUser.id, {
        appleId: user.appleId,
      } as any);
    }

    const tokens = await this.generateTokens(
      existingUser.id,
      existingUser.email,
      existingUser.role,
      metadata,
    );

    return {
      tokens,
      user: {
        id: existingUser.id,
        email: existingUser.email,
        firstName: existingUser.firstName,
        lastName: existingUser.lastName,
        role: existingUser.role,
      },
    };
  }

  async login(loginDto: LoginDto, metadata?: RequestMetadata) {
    const normalizedEmail = loginDto.email.toLowerCase().trim();
    const user = await this.usersService.findByEmail(normalizedEmail);

    if (user) {
      const isPasswordValid = await this.usersService.validatePassword(
        loginDto.password,
        user.password,
      );

      if (!isPasswordValid) {
        throw new UnauthorizedException('Invalid credentials');
      }

      if (!user.isActive) {
        throw new UnauthorizedException('Account is deactivated');
      }

      const tokens = await this.generateTokens(
        user.id,
        user.email,
        user.role,
        metadata,
        {
          authSource: 'user',
          vendorId: user.vendor_id ?? undefined,
        },
      );

      return {
        tokens,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          vendorId: user.vendor_id ?? null,
          adminAccess: resolveAdminAccess(user),
        },
      };
    }

    const vendor = await this.vendorsService.findByEmailWithPassword(normalizedEmail);
    if (!vendor || !this.vendorsService.vendorHasPortalAccess(vendor)) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (vendor.status !== VendorStatus.ACTIVE) {
      throw new UnauthorizedException('Vendor account is not active');
    }

    const isVendorPasswordValid = await this.vendorsService.validateVendorPassword(
      loginDto.password,
      vendor.password,
    );

    if (!isVendorPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const tokens = await this.generateTokens(
      -vendor.id,
      vendor.email!,
      UserRole.VENDOR_ADMIN,
      metadata,
      {
        authSource: 'vendor',
        vendorId: vendor.id,
      },
    );

    return {
      tokens,
      user: {
        id: vendor.id,
        email: vendor.email,
        firstName: vendor.name_en,
        lastName: vendor.name_ar,
        role: UserRole.VENDOR_ADMIN,
        vendorId: vendor.id,
        adminAccess: resolveAdminAccess({
          role: UserRole.VENDOR_ADMIN,
          adminAccess: null,
        }),
      },
    };
  }

  /**
   * Refresh access token using refresh token
   * Implements refresh token rotation for security
   */
  async refreshTokens(
    refreshToken: string,
    metadata?: RequestMetadata,
  ): Promise<AuthTokens> {
    try {
      // Verify the refresh token
      const payload = this.jwtService.verify<TokenPayload>(refreshToken);

      if (payload.type !== 'refresh') {
        throw new UnauthorizedException('Invalid token type');
      }

      // Check if refresh token exists and is not revoked
      const storedToken = await this.refreshTokenRepository.findOne({
        where: { token: payload.jti },
      });

      if (!storedToken) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      if (storedToken.revoked) {
        const revokedAtMs = storedToken.revokedAt?.getTime() ?? 0;
        const revokedRecently =
          revokedAtMs > 0 && Date.now() - revokedAtMs < 10_000;

        // Benign client race: another tab/request already rotated this token.
        // Re-use the replacement refresh token instead of logging the user out.
        if (storedToken.replacedByToken && revokedRecently) {
          return this.refreshTokens(storedToken.replacedByToken, metadata);
        }

        // Token reuse detected - possible theft
        // Revoke all tokens for this user as security measure
        await this.revokeAllUserTokens(payload.sub, 'token_reuse_detected');
        throw new UnauthorizedException(
          'Token has been revoked. Please login again.',
        );
      }

      if (new Date() > storedToken.expiresAt) {
        throw new UnauthorizedException('Refresh token has expired');
      }

      // Verify account still exists and is active
      if (payload.authSource === 'vendor') {
        const vendor = await this.vendorsService.findByEmailWithPassword(payload.email);
        const vendorId = payload.vendorId ?? Math.abs(payload.sub);
        if (
          !vendor ||
          vendor.id !== vendorId ||
          vendor.status !== VendorStatus.ACTIVE ||
          !this.vendorsService.vendorHasPortalAccess(vendor)
        ) {
          throw new UnauthorizedException('Vendor not found or deactivated');
        }
      } else {
        const user = await this.usersService.findOneById(payload.sub);
        if (!user || !user.isActive) {
          throw new UnauthorizedException('User not found or deactivated');
        }
      }

      // Revoke the old refresh token (rotation)
      storedToken.revoked = true;
      storedToken.revokedAt = new Date();

      // Generate new tokens
      const newTokens = await this.generateTokens(
        payload.sub,
        payload.email,
        payload.role,
        metadata,
        {
          authSource: payload.authSource,
          vendorId: payload.vendorId,
        },
      );

      // Link old token to new one for audit
      storedToken.replacedByToken = newTokens.refreshToken;
      await this.refreshTokenRepository.save(storedToken);

      return newTokens;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  /**
   * Logout - blacklist access token and revoke refresh token
   */
  async logout(accessToken: string, refreshToken?: string): Promise<void> {
    try {
      // Blacklist access token
      const accessPayload = this.jwtService.decode<TokenPayload>(accessToken);
      if (
        accessPayload &&
        accessPayload.jti &&
        accessPayload.type !== 'static_access'
      ) {
        const accessExpiry = new Date((accessPayload as any).exp * 1000);
        await this.tokenBlacklistRepository.save({
          jti: accessPayload.jti,
          userId: accessPayload.sub,
          expiresAt: accessExpiry,
          reason: 'logout',
        });
      }

      // Revoke refresh token if provided
      if (refreshToken) {
        const refreshPayload =
          this.jwtService.decode<TokenPayload>(refreshToken);
        if (refreshPayload && refreshPayload.jti) {
          await this.refreshTokenRepository.update(
            { token: refreshPayload.jti },
            { revoked: true, revokedAt: new Date() },
          );
        }
      }
    } catch {
      // Silently handle decode errors - token might be malformed
    }
  }

  /**
   * Logout from all devices - revoke all refresh tokens for user
   */
  async logoutAllDevices(
    userId: number,
    accessTokenJti?: string,
  ): Promise<void> {
    // Revoke all refresh tokens for user
    await this.revokeAllUserTokens(userId, 'logout_all_devices');

    // Blacklist current access token if provided
    if (accessTokenJti) {
      const accessExpiry = new Date(
        Date.now() + this.accessTokenExpiresIn * 1000,
      );
      await this.tokenBlacklistRepository.save({
        jti: accessTokenJti,
        userId,
        expiresAt: accessExpiry,
        reason: 'logout_all_devices',
      });
    }
  }

  /**
   * Revoke all refresh tokens for a user
   */
  private async revokeAllUserTokens(
    userId: number,
    reason: string,
  ): Promise<void> {
    await this.refreshTokenRepository.update(
      { userId, revoked: false },
      { revoked: true, revokedAt: new Date() },
    );
  }

  /**
   * Check if access token is blacklisted
   */
  async isTokenBlacklisted(jti: string): Promise<boolean> {
    const blacklisted = await this.tokenBlacklistRepository.findOne({
      where: { jti },
    });
    return !!blacklisted;
  }

  /**
   * Clean up expired tokens from database
   * Should be called periodically via cron job
   */
  async cleanupExpiredTokens(): Promise<void> {
    const now = new Date();

    // Remove expired refresh tokens
    await this.refreshTokenRepository.delete({
      expiresAt: LessThan(now),
    });

    // Remove expired blacklist entries
    await this.tokenBlacklistRepository.delete({
      expiresAt: LessThan(now),
    });

    // Remove expired password reset tokens
    await this.passwordResetTokenRepository.delete({
      expiresAt: LessThan(now),
    });
  }

  async validateUser(userId: number) {
    return await this.usersService.findOneById(userId);
  }

  /**
   * Validate token payload and check blacklist
   */
  async validateToken(payload: TokenPayload) {
    // Check if token is blacklisted
    if (
      payload.type !== 'static_access' &&
      (await this.isTokenBlacklisted(payload.jti))
    ) {
      throw new UnauthorizedException('Token has been revoked');
    }

    if (payload.authSource === 'vendor') {
      const vendor = await this.vendorsService.findByEmailWithPassword(payload.email);
      const vendorId = payload.vendorId ?? Math.abs(payload.sub);
      if (!vendor || vendor.id !== vendorId) {
        throw new UnauthorizedException('Vendor not found');
      }

      if (vendor.status !== VendorStatus.ACTIVE) {
        throw new UnauthorizedException('Vendor account is not active');
      }

      if (!this.vendorsService.vendorHasPortalAccess(vendor)) {
        throw new UnauthorizedException('Vendor portal access is disabled');
      }

      return {
        id: vendor.id,
        email: vendor.email,
        firstName: vendor.name_en,
        lastName: vendor.name_ar,
        role: UserRole.VENDOR_ADMIN,
        vendorId: vendor.id,
        authSource: 'vendor' as const,
        isActive: true,
        adminAccess: resolveAdminAccess({
          role: UserRole.VENDOR_ADMIN,
          adminAccess: null,
        }),
      };
    }

    // Validate user
    const user = await this.usersService.findOneById(payload.sub);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Account is deactivated');
    }

    // Remove password from user object
    const { password, ...result } = user;
    return {
      ...result,
      vendorId: user.vendor_id ?? null,
      authSource: 'user' as const,
      adminAccess: resolveAdminAccess(user),
    };
  }

  async forgotPassword(forgotPasswordDto: ForgotPasswordDto) {
    const user = await this.usersService.findByEmail(forgotPasswordDto.email);

    if (!user) {
      // Don't reveal if email exists or not for security
      return {
        data: null,
        message: 'If the email exists, a password reset link has been sent',
      };
    }

    // Generate secure random token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 1); // Token expires in 1 hour

    // Invalidate any existing tokens for this user
    await this.passwordResetTokenRepository.update(
      { userId: user.id, used: false },
      { used: true },
    );

    // Create new reset token
    const resetToken = this.passwordResetTokenRepository.create({
      token,
      userId: user.id,
      expiresAt,
    });

    await this.passwordResetTokenRepository.save(resetToken);

    // TODO: Send email with reset link
    // const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
    // await this.emailService.sendPasswordResetEmail(user.email, resetLink);

    return {
      data: { token }, // In production, remove this and only send via email
      message: 'Password reset link has been sent to your email',
    };
  }

  async resetPassword(resetPasswordDto: ResetPasswordDto) {
    // Find valid token
    const resetToken = await this.passwordResetTokenRepository.findOne({
      where: {
        token: resetPasswordDto.token,
        used: false,
      },
      relations: {
        user: true
      },
    });

    if (!resetToken) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    if (new Date() > resetToken.expiresAt) {
      throw new BadRequestException('Reset token has expired');
    }

    // Update user password
    await this.usersService.updatePassword(
      resetToken.userId,
      resetPasswordDto.newPassword,
    );

    // Mark token as used
    resetToken.used = true;
    await this.passwordResetTokenRepository.save(resetToken);

    // Clean up expired tokens
    await this.passwordResetTokenRepository.delete({
      expiresAt: LessThan(new Date()),
    });

    return {
      data: null,
      message: 'Password has been reset successfully',
    };
  }
}
