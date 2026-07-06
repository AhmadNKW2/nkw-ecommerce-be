import { Controller, Get, Query, UseGuards, Req, Res, UnauthorizedException } from '@nestjs/common';
import { SearchService } from './search.service';
import { SearchQueryDto, AutocompleteQueryDto } from './dto/search-query.dto';
import {
  SearchResponseDto,
  AutocompleteResponseDto,
} from './dto/search-response.dto';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { isCatalogAdminUser } from '../common/utils/catalog-access.util';

@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  /**
   * Full product search with filters, facets, pagination, and sorting.
   * GET /search?q=iphone&brand=Apple&category=Phones&page=1&per_page=20
   */
  @Get()
  @UseGuards(OptionalJwtAuthGuard)
  async search(
    @Query() query: SearchQueryDto,
    @Req() req: any,
    @Res({ passthrough: true }) res: any,
  ): Promise<any> {
    const isAdminUser = isCatalogAdminUser(req.user);

    if (query.is_admin === true && !isAdminUser) {
      throw new UnauthorizedException(
        'Admin authentication is required for admin search',
      );
    }

    if (query.is_admin === true) {
      res.setHeader(
        'Cache-Control',
        'private, no-store, no-cache, must-revalidate, proxy-revalidate',
      );
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Vary', 'Cookie');
    }

    const fullResponse = isAdminUser && query.is_admin === true;

    return this.searchService.search(query, isAdminUser, fullResponse);
  }

  /**
   * Fast autocomplete suggestions as the user types.
   * GET /search/autocomplete?q=iph&per_page=8
   */
  @Get('autocomplete')
  @UseGuards(OptionalJwtAuthGuard)
  autocomplete(
    @Query() query: AutocompleteQueryDto,
    @Req() req: any,
  ): Promise<AutocompleteResponseDto> {
    const isAdminUser = isCatalogAdminUser(req.user);

    return this.searchService.autocomplete(query, isAdminUser);
  }
}
