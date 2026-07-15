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
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles, UserRole } from '../common/decorators/roles.decorator';
import { RequireAdminAccess } from '../common/decorators/admin-access.decorator';
import { AnalyticsService } from './analytics.service';
import { AnalyticsVisitorsService } from './analytics-visitors.service';
import { AdminClientDevicesService } from './admin-client-devices.service';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';
import { CollectAnalyticsDto } from './dto/collect-analytics.dto';
import { ListVisitorsDto } from './dto/list-visitors.dto';
import { RegisterAdminClientDto } from './dto/register-admin-client.dto';

@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly analyticsService: AnalyticsService,
    private readonly analyticsVisitorsService: AnalyticsVisitorsService,
    private readonly adminClientDevicesService: AdminClientDevicesService,
  ) {}

  /** Public ingest from storefront (no auth). */
  @Post('collect')
  collect(@Body() dto: CollectAnalyticsDto) {
    return this.analyticsVisitorsService.collect(dto);
  }

  @Post('admin-clients/register')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(
    UserRole.ADMIN,
    UserRole.CONSTANT_TOKEN_ADMIN,
    UserRole.CATALOG_MANAGER,
    UserRole.VENDOR_ADMIN,
    UserRole.STORE_ADMIN,
  )
  registerAdminClient(
    @Req() req: { user: { id: number } },
    @Body() dto: RegisterAdminClientDto,
  ) {
    return this.adminClientDevicesService.register(req.user.id, dto);
  }

  @Get('admin-clients/me')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(
    UserRole.ADMIN,
    UserRole.CONSTANT_TOKEN_ADMIN,
    UserRole.CATALOG_MANAGER,
    UserRole.VENDOR_ADMIN,
    UserRole.STORE_ADMIN,
  )
  listMyAdminClients(@Req() req: { user: { id: number } }) {
    return this.adminClientDevicesService.listMine(req.user.id);
  }

  @Get('admin-clients')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.CONSTANT_TOKEN_ADMIN)
  @RequireAdminAccess('analytics')
  listAdminClients() {
    return this.adminClientDevicesService.listForAdmin();
  }

  @Get('overview')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('analytics')
  getOverview(@Query() query: AnalyticsQueryDto) {
    return this.analyticsService.getOverview(query);
  }

  @Get('visitors')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('analytics')
  listVisitors(@Query() query: ListVisitorsDto) {
    return this.analyticsVisitorsService.listVisitors(query);
  }

  @Get('visitors/:id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('analytics')
  getVisitor(@Param('id', ParseIntPipe) id: number) {
    return this.analyticsVisitorsService.getVisitor(id);
  }
}
