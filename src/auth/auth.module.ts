import { Logger, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UsersModule } from '../users/users.module';
import { JwtStrategy } from './strategies/jwt.strategy';
import { GoogleStrategy } from './strategies/google.strategy';
import { FacebookStrategy } from './strategies/facebook.strategy';
import { AppleStrategy } from './strategies/apple.strategy';
import { TokenCleanupService } from './services/token-cleanup.service';
import { PasswordResetToken } from './entities/password-reset-token.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { TokenBlacklist } from './entities/token-blacklist.entity';
import { OAuthProviderEnabledGuard } from './guards/oauth-provider-enabled.guard';
import {
  getAllOAuthProviderStatuses,
  shouldRegisterOAuthStrategy,
} from './oauth-providers.config';

const logger = new Logger('AuthModule');

const oauthStrategyProviders = [
  shouldRegisterOAuthStrategy('google') ? GoogleStrategy : null,
  shouldRegisterOAuthStrategy('facebook') ? FacebookStrategy : null,
  shouldRegisterOAuthStrategy('apple') ? AppleStrategy : null,
].filter((provider): provider is typeof GoogleStrategy => provider !== null);

const oauthStatuses = getAllOAuthProviderStatuses();
for (const [provider, status] of Object.entries(oauthStatuses)) {
  if (!status.enabled) {
    logger.log(`${provider} login is disabled by environment flag`);
    continue;
  }

  if (!status.configured) {
    logger.warn(
      `${provider} login is enabled but missing required OAuth credentials`,
    );
  }
}

@Module({
  imports: [
    UsersModule,
    PassportModule,
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([
      PasswordResetToken,
      RefreshToken,
      TokenBlacklist,
    ]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret:
          configService.get('JWT_SECRET') ||
          'your-secret-key-change-in-production',
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    OAuthProviderEnabledGuard,
    ...oauthStrategyProviders,
    TokenCleanupService,
  ],
  exports: [AuthService],
})
export class AuthModule {}
