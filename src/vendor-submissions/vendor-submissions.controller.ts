import {
  Body,
  Controller,
  ForbiddenException,
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
import {
  isSimplifiedProductCreator,
  resolveCreatorVendorId,
} from '../products/utils/simplified-product-creator.util';
import { CreateVendorSubmissionDto } from './dto/create-vendor-submission.dto';
import { ListVendorSubmissionsDto } from './dto/list-vendor-submissions.dto';
import { VendorSubmissionsService } from './vendor-submissions.service';

const SUBMISSION_ROLES = [
  UserRole.ADMIN,
  UserRole.CONSTANT_TOKEN_ADMIN,
  UserRole.CATALOG_MANAGER,
  UserRole.VENDOR_ADMIN,
  UserRole.STORE_ADMIN,
] as const;

@ApiTags('vendor-submissions')
@Controller('vendor-submissions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class VendorSubmissionsController {
  constructor(
    private readonly submissionsService: VendorSubmissionsService,
  ) {}

  private assertAdminOnly(user?: { role?: string } | null): void {
    if (isSimplifiedProductCreator(user)) {
      throw new ForbiddenException(
        "You don't have permission to perform this action",
      );
    }
  }

  private resolveScopeVendorId(user: any): number | undefined {
    if (isSimplifiedProductCreator(user)) {
      return resolveCreatorVendorId(user) ?? -1;
    }
    return undefined;
  }

  @Post()
  @Roles(...SUBMISSION_ROLES)
  @RequireAdminAccess('products')
  @ApiOperation({ summary: 'Create a vendor AI product submission' })
  create(@Body() dto: CreateVendorSubmissionDto, @Req() req: any) {
    return this.submissionsService.create(dto, {
      id: req.user?.id,
      role: req.user?.role,
      authSource: req.user?.authSource,
      vendorId: req.user?.vendorId ?? req.user?.vendor_id ?? null,
      adminAccess: req.user?.adminAccess ?? null,
    });
  }

  @Get()
  @Roles(...SUBMISSION_ROLES)
  @RequireAdminAccess('products')
  @ApiOperation({ summary: 'List vendor submissions' })
  list(@Query() dto: ListVendorSubmissionsDto, @Req() req: any) {
    return this.submissionsService.list(dto, this.resolveScopeVendorId(req.user));
  }

  @Get(':id')
  @Roles(...SUBMISSION_ROLES)
  @RequireAdminAccess('products')
  @ApiOperation({ summary: 'Get a vendor submission' })
  findOne(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    const scopeVendorId = this.resolveScopeVendorId(req.user);
    return this.submissionsService.findOne(
      id,
      scopeVendorId && scopeVendorId > 0 ? scopeVendorId : undefined,
    );
  }

  @Post(':id/run-ai')
  @Roles(UserRole.ADMIN, UserRole.CONSTANT_TOKEN_ADMIN, UserRole.CATALOG_MANAGER)
  @RequireAdminAccess('products')
  @ApiOperation({
    summary: 'Re-run Stage 2 enrichment after category specs/attributes are set',
  })
  runAi(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    this.assertAdminOnly(req.user);
    return this.submissionsService.runStage2(id);
  }

  @Post(':id/materialize')
  @Roles(UserRole.ADMIN, UserRole.CONSTANT_TOKEN_ADMIN, UserRole.CATALOG_MANAGER)
  @RequireAdminAccess('products')
  @ApiOperation({ summary: 'Create a real product from a ready submission' })
  materialize(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    this.assertAdminOnly(req.user);
    return this.submissionsService.materialize(id, req.user?.id);
  }
}
