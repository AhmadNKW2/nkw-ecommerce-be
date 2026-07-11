import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';

/**
 * Versioned search-response cache. Bump the generation after Typesense
 * reindex so stale totals/ranking are not served from an older index state.
 */
@Injectable()
export class SearchCacheService {
  static readonly GENERATION_CACHE_KEY = 'search:cache-generation';
  private readonly logger = new Logger(SearchCacheService.name);

  constructor(@Inject(CACHE_MANAGER) private readonly cacheManager: Cache) {}

  async getGeneration(): Promise<number> {
    const cached = await this.cacheManager.get<number>(
      SearchCacheService.GENERATION_CACHE_KEY,
    );
    return Number.isInteger(cached) && (cached as number) > 0
      ? (cached as number)
      : 1;
  }

  async invalidateSearchCache(reason?: string): Promise<number> {
    const nextGeneration = (await this.getGeneration()) + 1;
    // ttl 0 = no expiry — generation must not reset while old cache keys linger.
    await this.cacheManager.set(
      SearchCacheService.GENERATION_CACHE_KEY,
      nextGeneration,
      0,
    );
    this.logger.log(
      `Search cache invalidated${reason ? ` (${reason})` : ''} → generation v${nextGeneration}`,
    );
    return nextGeneration;
  }

  async buildCacheKey(prefix: string, payload: string): Promise<string> {
    const generation = await this.getGeneration();
    return `${prefix}:v${generation}:${payload}`;
  }
}
