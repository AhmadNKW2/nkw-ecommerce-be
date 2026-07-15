import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
  Req,
  BadRequestException,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { BrandsService } from './brands.service';
import { CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';
import { FilterBrandDto } from './dto/filter-brand.dto';
import { FilterProductDto } from '../products/dto/filter-product.dto';
import { AuthGuard } from '@nestjs/passport';
import { Roles, UserRole } from '../common/decorators/roles.decorator';
import { RequireAdminAccess } from '../common/decorators/admin-access.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import {
  RestoreBrandDto,
  PermanentDeleteBrandDto,
} from './dto/archive-brand.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { imageFileFilter } from '../common/utils/file-upload.helper';
import { R2StorageService } from '../common/services/r2-storage.service';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { shouldReturnAdminEntityDetail } from '../common/utils/catalog-access.util';

@Controller('brands')
export class BrandsController {
  constructor(
    private readonly brandsService: BrandsService,
    private readonly r2StorageService: R2StorageService,
  ) {}

  @Post()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.CATALOG_MANAGER)
  @RequireAdminAccess('brands')
  @UseInterceptors(
    FileInterceptor('logo', {
      storage: memoryStorage(),
      fileFilter: imageFileFilter,
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  )
  async create(
    @Body() createBrandDto: CreateBrandDto,
    @UploadedFile() logo: Express.Multer.File,
    @Req() req: any,
  ) {
    let logoUrl: string | undefined;
    if (logo) {
      const uploadResult = await this.r2StorageService.uploadFile(
        logo,
        'brands',
      );
      logoUrl = uploadResult.url;
    }
    return this.brandsService.create(createBrandDto, logoUrl);
  }

  @Get()
  findAll(@Query() filterDto: FilterBrandDto) {
    return this.brandsService.findAll(filterDto);
  }

  @Get('archive/list')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.CATALOG_MANAGER)
  @RequireAdminAccess('archived')
  findArchived() {
    return this.brandsService.findArchived();
  }

  @Get(':id')
  @UseGuards(OptionalJwtAuthGuard)
  findOne(
    @Param('id') id: string,
    @Query() filterDto: FilterProductDto,
    @Req() req: any,
  ) {
    return this.brandsService.findOne(
      +id,
      filterDto,
      shouldReturnAdminEntityDetail(req.user, filterDto),
    );
  }

  @Get('slug/:slug')
  @UseGuards(OptionalJwtAuthGuard)
  findOneBySlug(
    @Param('slug') slug: string,
    @Query() filterDto: FilterProductDto,
    @Req() req: any,
  ) {
    return this.brandsService.findOneBySlug(
      slug,
      filterDto,
      shouldReturnAdminEntityDetail(req.user, filterDto),
    );
  }

  @Patch(':id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.CATALOG_MANAGER)
  @RequireAdminAccess('brands')
  @UseInterceptors(
    FileInterceptor('logo', {
      storage: memoryStorage(),
      fileFilter: imageFileFilter,
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  )
  async update(
    @Param('id') id: string,
    @Body() updateBrandDto: UpdateBrandDto,
    @UploadedFile() logo: Express.Multer.File,
    @Req() req: any,
  ) {
    let logoUrl: string | undefined;
    if (logo) {
      const uploadResult = await this.r2StorageService.uploadFile(
        logo,
        'brands',
      );
      logoUrl = uploadResult.url;
    }
    return this.brandsService.update(+id, updateBrandDto, logoUrl);
  }

  @Post(':id/archive')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.CATALOG_MANAGER)
  @RequireAdminAccess('brands')
  archive(@Param('id') id: string, @Req() req: any) {
    return this.brandsService.archive(+id, req.user.id);
  }

  @Post(':id/restore')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.CATALOG_MANAGER)
  @RequireAdminAccess('archived')
  restore(@Param('id') id: string, @Body() restoreDto?: RestoreBrandDto) {
    return this.brandsService.restore(+id, restoreDto);
  }

  @Delete(':id/permanent')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('archived')
  permanentDelete(
    @Param('id') id: string,
    @Body() options?: PermanentDeleteBrandDto,
  ) {
    return this.brandsService.permanentDelete(+id, options);
  }

  @Delete(':id')
  removeFallback() {
    throw new BadRequestException(
      'Use /brands/:id/permanent for deleting brands',
    );
  }
}
