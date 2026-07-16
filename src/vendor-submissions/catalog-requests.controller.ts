import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireAdminAccess } from '../common/decorators/admin-access.decorator';
import { Roles, UserRole } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CatalogRequestsService } from './catalog-requests.service';
import {
  ApproveCatalogRequestDto,
  ListCatalogRequestsDto,
  RejectCatalogRequestDto,
} from './dto/catalog-request.dto';

@ApiTags('catalog-requests')
@Controller('catalog-requests')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.CONSTANT_TOKEN_ADMIN, UserRole.CATALOG_MANAGER)
@RequireAdminAccess('catalog_requests')
export class CatalogRequestsController {
  constructor(
    private readonly catalogRequestsService: CatalogRequestsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List brand/category creation requests' })
  list(@Query() dto: ListCatalogRequestsDto) {
    return this.catalogRequestsService.list(dto);
  }

  @Get('pending-count')
  @ApiOperation({ summary: 'Count pending catalog requests' })
  async pendingCount() {
    return { count: await this.catalogRequestsService.countPending() };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a catalog request' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.catalogRequestsService.findOne(id);
  }

  @Post(':id/approve')
  @ApiOperation({ summary: 'Approve (and create) a brand/category request' })
  approve(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ApproveCatalogRequestDto,
    @Req() req: any,
  ) {
    return this.catalogRequestsService.approve(id, dto, req.user?.id);
  }

  @Post(':id/reject')
  @ApiOperation({ summary: 'Reject a brand/category request' })
  reject(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RejectCatalogRequestDto,
    @Req() req: any,
  ) {
    return this.catalogRequestsService.reject(id, dto, req.user?.id);
  }
}
