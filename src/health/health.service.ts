import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import {
  CACHE_BACKEND_REDIS,
  resolveCacheBackend,
} from '../common/cache/app-cache.module';
import { SEARCH_EXPANSION_VERSION } from '../search/utils/spec-expansion.utils';
import { TypesenseService } from '../typesense/typesense.service';

@Injectable()
export class HealthService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly typesenseService: TypesenseService,
    private readonly configService: ConfigService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  async check() {
    const timestamp = new Date().toISOString();
    const uptime = process.uptime();

    const start = Date.now();
    try {
      // Lightweight query to ensure the DB compute is awake (Neon Scale-to-Zero).
      await this.dataSource.query('SELECT 1');
      const latencyMs = Date.now() - start;

      const cacheBackend = resolveCacheBackend(this.configService);
      let redisOk: boolean | undefined;
      let redisLatencyMs: number | undefined;
      if (cacheBackend === CACHE_BACKEND_REDIS) {
        const probeKey = 'health:cache-probe';
        const probeStarted = Date.now();
        try {
          await this.cacheManager.set(probeKey, Date.now(), 10_000);
          const probeValue = await this.cacheManager.get<number>(probeKey);
          redisOk = typeof probeValue === 'number';
          redisLatencyMs = Date.now() - probeStarted;
        } catch {
          redisOk = false;
          redisLatencyMs = Date.now() - probeStarted;
        }
      }

      return {
        status: 'ok',
        timestamp,
        uptime,
        search: {
          expansion_version: SEARCH_EXPANSION_VERSION,
          git_commit:
            process.env.RAILWAY_GIT_COMMIT_SHA ??
            process.env.GIT_COMMIT_SHA ??
            undefined,
        },
        cache: {
          backend: cacheBackend,
          redis_configured: Boolean(this.configService.get<string>('REDIS_URL')?.trim()),
          redis_ok: redisOk,
          redis_latency_ms: redisLatencyMs,
          shared_across_instances: cacheBackend === CACHE_BACKEND_REDIS && redisOk !== false,
        },
        db: {
          status: 'ok',
          latency_ms: latencyMs,
        },
      };
    } catch (error) {
      const latencyMs = Date.now() - start;
      throw new ServiceUnavailableException({
        status: 'unavailable',
        timestamp,
        uptime,
        db: {
          status: 'down',
          latency_ms: latencyMs,
        },
      });
    }
  }

  async checkTypesense() {
    const result = await this.typesenseService.healthCheck();

    if (result.status === 'down') {
      throw new ServiceUnavailableException({
        status: 'unavailable',
        timestamp: new Date().toISOString(),
        typesense: result,
      });
    }

    return {
      status: result.status === 'disabled' ? 'ok' : 'ok',
      timestamp: new Date().toISOString(),
      typesense: result,
    };
  }
}
