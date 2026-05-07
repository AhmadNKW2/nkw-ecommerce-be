import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Req,
  Put,
  Query,
  ParseIntPipe,
} from '@nestjs/common';
import {
  ApiExtraModels,
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  getSchemaPath,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { VendorsService } from './vendors.service';
import { CreateVendorDto } from './dto/create-vendor.dto';
import { UpdateVendorDto } from './dto/update-vendor.dto';
import {
  PermanentDeleteVendorDto,
  RestoreVendorDto,
} from './dto/archive-vendor.dto';
import { ReorderVendorsDto } from './dto/reorder-vendors.dto';
import { AssignProductsToVendorDto } from './dto/assign-products.dto';
import { FilterProductDto } from '../products/dto/filter-product.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles, UserRole } from '../common/decorators/roles.decorator';
import { imageFileFilter } from '../common/utils/file-upload.helper';
import { R2StorageService } from '../common/services/r2-storage.service';
import { CreateVendorCategoryDto } from './dto/create-vendor-category.dto';
import {
  ReplaceVendorCategoriesTreeDto,
  replaceVendorCategoriesTreeSwaggerExample,
} from './dto/replace-vendor-categories-tree.dto';
import { UpdateVendorCategoryDto } from './dto/update-vendor-category.dto';
import { ApiErrorResponseDto } from '../common/swagger/api-response.dto';
import type {
  SerializedVendorCategory,
  SerializedVendorCategoryListItem,
} from './vendors.service';

@Controller('vendors')
export class VendorsController {
  constructor(
    private readonly vendorsService: VendorsService,
    private readonly r2StorageService: R2StorageService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.CATALOG_MANAGER)
  @UseInterceptors(
    FileInterceptor('logo', {
      storage: memoryStorage(),
      fileFilter: imageFileFilter,
      limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    }),
  )
  async create(
    @Body() createVendorDto: CreateVendorDto,
    @UploadedFile() logo: Express.Multer.File,
    @Req() req: any,
  ) {
    let logoUrl: string | undefined;
    if (logo) {
      const uploadResult = await this.r2StorageService.uploadFile(
        logo,
        'vendors',
      );
      logoUrl = uploadResult.url;
    }
    return this.vendorsService.create(createVendorDto, logoUrl);
  }

  @Get()
  findAll() {
    return this.vendorsService.findAll();
  }

  @Get('archive/list')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.CATALOG_MANAGER)
  findArchived() {
    return this.vendorsService.findArchived();
  }

  @Post(':id/categories')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.CATALOG_MANAGER)
  createCategory(
    @Param('id', ParseIntPipe) id: number,
    @Body() createVendorCategoryDto: CreateVendorCategoryDto,
  ): Promise<SerializedVendorCategory> {
    return this.vendorsService.createVendorCategory(id, createVendorCategoryDto);
  }

  @Get(':id/categories')
  @ApiOperation({
    summary:
      'Get vendor categories as a flat leaf-first list with assigned categories',
  })
  @ApiParam({
    name: 'id',
    example: 2,
    description: 'Vendor id.',
  })
  @ApiOkResponse({
    description:
      'Vendor categories returned as a flat list ordered from deepest children to parents.',
    schema: {
      example: {
        success: true,
        data: [
          {
            id: 3,
            title: 'QD-OLED',
            reference_link: '/displays/oled/qd-oled',
            vendor_id: 2,
            parent_id: 2,
            category_ids: [13],
            categories: [
              {
                id: 13,
                name_en: 'QD-OLED Monitors',
                slug: 'qd-oled-monitors',
              },
            ],
            created_at: '2026-05-05T08:00:00.000Z',
            updated_at: '2026-05-05T08:00:00.000Z',
          },
          {
            id: 2,
            title: 'OLED',
            reference_link: '/displays/oled',
            vendor_id: 2,
            parent_id: 1,
            category_ids: [12],
            categories: [
              {
                id: 12,
                name_en: 'OLED Monitors',
                slug: 'oled-monitors',
              },
            ],
            created_at: '2026-05-05T08:00:00.000Z',
            updated_at: '2026-05-05T08:00:00.000Z',
          },
          {
            id: 4,
            title: 'LCD',
            reference_link: '/displays/lcd',
            vendor_id: 2,
            parent_id: 1,
            category_ids: [14],
            categories: [
              {
                id: 14,
                name_en: 'LCD Monitors',
                slug: 'lcd-monitors',
              },
            ],
            created_at: '2026-05-05T08:00:00.000Z',
            updated_at: '2026-05-05T08:00:00.000Z',
          },
          {
            id: 1,
            title: 'Displays',
            reference_link: '/displays',
            vendor_id: 2,
            parent_id: null,
            category_ids: [9],
            categories: [
              {
                id: 9,
                name_en: 'Monitors',
                slug: 'monitors',
              },
            ],
            created_at: '2026-05-05T08:00:00.000Z',
            updated_at: '2026-05-05T08:00:00.000Z',
          },
        ],
        message: 'Success',
        time: '2026-05-05T08:00:00.000Z',
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Vendor not found.',
    type: ApiErrorResponseDto,
  })
  findCategories(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<SerializedVendorCategoryListItem[]> {
    return this.vendorsService.findVendorCategories(id);
  }

  @Get(':id/categories/tree')
  findCategoryTree(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<SerializedVendorCategory[]> {
    return this.vendorsService.findVendorCategoriesTree(id);
  }

  @Put(':id/categories/tree')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.CATALOG_MANAGER)
  @ApiExtraModels(ReplaceVendorCategoriesTreeDto)
  @ApiOperation({
    summary: 'Replace the full vendor category tree in one payload',
  })
  @ApiParam({
    name: 'id',
    example: 2,
    description: 'Vendor id.',
  })
  @ApiBody({
    description:
      'Replaces the current vendor category tree for this vendor. Existing vendor categories are removed and recreated from this nested payload. Array order is used as sibling order.',
    schema: {
      allOf: [{ $ref: getSchemaPath(ReplaceVendorCategoriesTreeDto) }],
      example: replaceVendorCategoriesTreeSwaggerExample,
    },
  })
  @ApiOkResponse({
    description: 'Vendor category tree replaced successfully.',
    schema: {
      example: {
        success: true,
        data: [
          {
            id: 1,
            title: 'Components',
            reference_link: '/components',
            vendor_id: 2,
            parent_id: null,
            category_ids: [42],
            sort_order: 0,
            categories: [
              {
                id: 42,
                name_en: 'Components',
                slug: 'components',
              },
            ],
            children: [
              {
                id: 2,
                title: 'Desktop RAM',
                reference_link: '/components/desktop-ram',
                vendor_id: 2,
                parent_id: 1,
                category_ids: [48],
                sort_order: 0,
                categories: [
                  {
                    id: 48,
                    name_en: 'Desktop RAM',
                    slug: 'desktop-ram',
                  },
                ],
                children: [],
                created_at: '2026-05-05T08:00:00.000Z',
                updated_at: '2026-05-05T08:00:00.000Z',
              },
              {
                id: 3,
                title: 'CPU Coolers',
                reference_link: '/components/cpu-coolers',
                vendor_id: 2,
                parent_id: 1,
                category_ids: [],
                sort_order: 1,
                categories: [],
                children: [],
                created_at: '2026-05-05T08:00:00.000Z',
                updated_at: '2026-05-05T08:00:00.000Z',
              },
            ],
            created_at: '2026-05-05T08:00:00.000Z',
            updated_at: '2026-05-05T08:00:00.000Z',
          },
          {
            id: 4,
            title: 'Peripherals',
            reference_link: '/peripherals',
            vendor_id: 2,
            parent_id: null,
            category_ids: [],
            sort_order: 1,
            categories: [],
            children: [
              {
                id: 5,
                title: 'Keyboards',
                reference_link: '/peripherals/keyboards',
                vendor_id: 2,
                parent_id: 4,
                category_ids: [10],
                sort_order: 0,
                categories: [
                  {
                    id: 10,
                    name_en: 'Keyboards',
                    slug: 'keyboards',
                  },
                ],
                children: [],
                created_at: '2026-05-05T08:00:00.000Z',
                updated_at: '2026-05-05T08:00:00.000Z',
              },
            ],
            created_at: '2026-05-05T08:00:00.000Z',
            updated_at: '2026-05-05T08:00:00.000Z',
          },
        ],
        message: 'Success',
        time: '2026-05-05T08:00:00.000Z',
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Validation error or malformed tree payload.',
    type: ApiErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'Request conflicts with the current vendor category tree.',
    type: ApiErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Vendor or one of the mapped categories was not found.',
    type: ApiErrorResponseDto,
  })
  replaceCategoryTree(
    @Param('id', ParseIntPipe) id: number,
    @Body() replaceVendorCategoriesTreeDto: ReplaceVendorCategoriesTreeDto,
  ): Promise<SerializedVendorCategory[]> {
    return this.vendorsService.replaceVendorCategoriesTree(
      id,
      replaceVendorCategoriesTreeDto,
    );
  }

  @Get(':id/categories/:categoryId')
  findOneCategory(
    @Param('id', ParseIntPipe) id: number,
    @Param('categoryId', ParseIntPipe) categoryId: number,
  ): Promise<SerializedVendorCategory> {
    return this.vendorsService.findOneVendorCategory(id, categoryId);
  }

  @Patch(':id/categories/:categoryId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.CATALOG_MANAGER)
  updateCategory(
    @Param('id', ParseIntPipe) id: number,
    @Param('categoryId', ParseIntPipe) categoryId: number,
    @Body() updateVendorCategoryDto: UpdateVendorCategoryDto,
  ): Promise<SerializedVendorCategory> {
    return this.vendorsService.updateVendorCategory(
      id,
      categoryId,
      updateVendorCategoryDto,
    );
  }

  @Delete(':id/categories/:categoryId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.CATALOG_MANAGER)
  removeCategory(
    @Param('id', ParseIntPipe) id: number,
    @Param('categoryId', ParseIntPipe) categoryId: number,
  ) {
    return this.vendorsService.removeVendorCategory(id, categoryId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Query() filterDto: FilterProductDto) {
    return this.vendorsService.findOne(+id, filterDto);
  }

  @Get('slug/:slug')
  findOneBySlug(@Param('slug') slug: string, @Query() filterDto: FilterProductDto) {
    return this.vendorsService.findOneBySlug(slug, filterDto);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.CATALOG_MANAGER)
  @UseInterceptors(
    FileInterceptor('logo', {
      storage: memoryStorage(),
      fileFilter: imageFileFilter,
      limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    }),
  )
  async update(
    @Param('id') id: string,
    @Body() updateVendorDto: UpdateVendorDto,
    @UploadedFile() logo: Express.Multer.File,
    @Req() req: any,
  ) {
    let logoUrl: string | undefined;
    if (logo) {
      const uploadResult = await this.r2StorageService.uploadFile(
        logo,
        'vendors',
      );
      logoUrl = uploadResult.url;
    }
    return this.vendorsService.update(+id, updateVendorDto, logoUrl);
  }

  // ========== LIFECYCLE MANAGEMENT ==========

  @Post(':id/archive')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.CATALOG_MANAGER)
  archive(@Param('id') id: string, @Req() req: any) {
    return this.vendorsService.archive(+id, req.user.id);
  }

  @Post(':id/restore')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.CATALOG_MANAGER)
  restore(@Param('id') id: string, @Body() restoreDto?: RestoreVendorDto) {
    return this.vendorsService.restore(+id, restoreDto);
  }

  @Delete(':id/permanent')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  permanentDelete(
    @Param('id') id: string,
    @Body() options?: PermanentDeleteVendorDto,
  ) {
    return this.vendorsService.permanentDelete(+id, options);
  }

  @Put('reorder')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.CATALOG_MANAGER)
  reorder(@Body() dto: ReorderVendorsDto) {
    return this.vendorsService.reorder(dto);
  }

  // ========== PRODUCT ASSIGNMENT ==========

  // Assign products to this vendor
  @Post(':id/products')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.CATALOG_MANAGER)
  assignProducts(
    @Param('id') id: string,
    @Body() dto: AssignProductsToVendorDto,
  ) {
    return this.vendorsService.assignProducts(+id, dto.product_ids);
  }

  // Remove products from this vendor
  @Delete(':id/products')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.CATALOG_MANAGER)
  removeProducts(
    @Param('id') id: string,
    @Body() dto: AssignProductsToVendorDto,
  ) {
    return this.vendorsService.removeProducts(+id, dto.product_ids);
  }

  // Get products for this vendor
  @Get(':id/products')
  getProducts(@Param('id') id: string) {
    return this.vendorsService.getProducts(+id);
  }
}
