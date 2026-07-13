import { CacheModule } from '@nestjs/cache-manager';
import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import KeyvRedis from '@keyv/redis';
import { Keyv } from 'keyv';

export const CACHE_BACKEND_MEMORY = 'memory';
export const CACHE_BACKEND_REDIS = 'redis';

export function resolveCacheBackend(configService: ConfigService): string {
  const redisUrl = configService.get<string>('REDIS_URL')?.trim();
  return redisUrl ? CACHE_BACKEND_REDIS : CACHE_BACKEND_MEMORY;
}

@Global()
@Module({
  imports: [
    CacheModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => {
        const redisUrl = configService.get<string>('REDIS_URL')?.trim();
        const ttlMs = Number(configService.get<string>('CACHE_TTL', '300')) * 1000;
        const max = Number(configService.get<string>('CACHE_MAX', '500'));

        if (redisUrl) {
          return {
            stores: [
              new Keyv({
                store: new KeyvRedis(redisUrl),
                ttl: ttlMs,
              }),
            ],
          };
        }

        return {
          ttl: ttlMs,
          max,
        };
      },
    }),
  ],
  exports: [CacheModule],
})
export class AppCacheModule {}
