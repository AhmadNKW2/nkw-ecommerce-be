import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles, UserRole } from '../common/decorators/roles.decorator';
import { RequireAdminAccess } from '../common/decorators/admin-access.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { SearchCacheService } from './search-cache.service';
import { TypesenseBackfillService } from '../typesense/typesense-backfill.service';

@Controller('admin/search')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@RequireAdminAccess('settings')
export class AdminSearchController {
  constructor(
    private readonly searchCacheService: SearchCacheService,
    private readonly typesenseBackfillService: TypesenseBackfillService,
  ) {}

  /**
   * Clears versioned search/autocomplete response cache without restarting the server.
   * POST /admin/search/cache/invalidate
   */
  @Post('cache/invalidate')
  async invalidateSearchCache() {
    const cacheGeneration =
      await this.searchCacheService.invalidateSearchCache('admin manual');

    return {
      message: 'Search cache invalidated.',
      cache_generation: cacheGeneration,
    };
  }

  /**
   * Starts a Typesense reindex from the database in the background.
   * POST /admin/search/typesense/backfill
   */
  @Post('typesense/backfill')
  startTypesenseBackfill() {
    this.typesenseBackfillService.startFullBackfillInBackground();

    return {
      message: 'Typesense backfill started.',
      status: 'running',
    };
  }

  /**
   * Deletes all Typesense product documents by recreating the collection.
   * Does not reindex — use /typesense/backfill afterward.
   * POST /admin/search/typesense/clear
   */
  @Post('typesense/clear')
  async clearTypesenseCollection() {
    const result = await this.typesenseBackfillService.clearCollection();

    return {
      message: 'Typesense product collection cleared.',
      ...result,
    };
  }

  /**
   * GET /admin/search/typesense/backfill/status
   */
  @Get('typesense/backfill/status')
  getTypesenseBackfillStatus() {
    return this.typesenseBackfillService.getStatus();
  }
}
