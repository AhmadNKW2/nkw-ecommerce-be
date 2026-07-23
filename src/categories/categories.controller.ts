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
  BadRequestException,
  Request,
  Put,
  Req,
  Query,
  ParseIntPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { FilterCategoryDto } from './dto/filter-category.dto';
import { FilterProductDto } from '../products/dto/filter-product.dto';
import {
  RestoreCategoryDto,
  PermanentDeleteCategoryDto,
} from './dto/archive-category.dto';
import { CreateCategoryUrlDto } from './dto/create-category-url.dto';
import { UpdateCategoryUrlDto } from './dto/update-category-url.dto';
import { FilterCategoryUrlDto } from './dto/filter-category-url.dto';
import { ReorderCategoriesDto } from './dto/reorder-categories.dto';
import { AssignProductsToCategoryDto } from './dto/assign-products.dto';
import { Roles, UserRole } from '../common/decorators/roles.decorator';
import { RequireAdminAccess } from '../common/decorators/admin-access.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { shouldReturnAdminEntityDetail } from '../common/utils/catalog-access.util';
import { imageFileFilter } from '../common/utils/file-upload.util';
import { R2StorageService } from '../common/services/r2-storage.service';
import { ApiErrorResponseDto } from '../common/swagger/api-response.dto';

const CATEGORY_URL_MANAGER_ROLES = [
  UserRole.ADMIN,  UserRole.CONSTANT_TOKEN_ADMIN,
] as const;

@ApiTags('Categories')
@ApiBearerAuth('bearer')
@ApiCookieAuth('cookieAuth')
@ApiUnauthorizedResponse({
  description: 'Authentication is required.',
  type: ApiErrorResponseDto,
})
@ApiForbiddenResponse({
  description: 'The current user does not have access to this operation.',
  type: ApiErrorResponseDto,
})
@Controller('categories')
export class CategoriesController {
  constructor(
    private readonly categoriesService: CategoriesService,
    private readonly r2StorageService: R2StorageService,
  ) {}

  // Admin only routes
  @Post()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('categories')
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
      fileFilter: imageFileFilter,
      limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
    }),
  )
  async create(
    @Body() createCategoryDto: CreateCategoryDto,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    if (file) {
      const uploadResult = await this.r2StorageService.uploadFile(
        file,
        'categories',
      );
      createCategoryDto.image = uploadResult.url;
    }
    return this.categoriesService.create(createCategoryDto);
  }

  // Filter categories (Public)
  @Post('filter')
  filterCategories(@Body() filterDto: FilterCategoryDto) {
    return this.categoriesService.findAll(filterDto);
  }

  @Patch(':id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('categories')
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
      fileFilter: imageFileFilter,
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  async update(
    @Param('id') id: number,
    @Body() updateCategoryDto: UpdateCategoryDto,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    if (file) {
      const uploadResult = await this.r2StorageService.uploadFile(
        file,
        'categories',
      );
      updateCategoryDto.image = uploadResult.url;
    }
    return this.categoriesService.update(id, updateCategoryDto);
  }

  // Public routes
  @Get()
  findAll() {
    return this.categoriesService.findAll();
  }

  @Get('tree')
  getCategoryTree() {
    return this.categoriesService.getCategoryTree();
  }

  // Get archived categories (trash view) - includes archived products and subcategories
  @Get('archive/list')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('archived')
  findArchived(@Body() filterDto?: FilterCategoryDto) {
    return this.categoriesService.findArchived(filterDto);
  }

  // ========== CATEGORY URLS ==========

  @Post('urls')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(...CATEGORY_URL_MANAGER_ROLES)
  @RequireAdminAccess('categories')
  @ApiOperation({ summary: 'Create a category URL mapping' })
  @ApiBody({
    type: CreateCategoryUrlDto,
    examples: {
      category_url: {
        summary: 'Add one URL for a category',
        value: {
          url: 'https://store.example.com/monitors/gaming-monitors',
          category_id: 9,
          sort_order: 0,
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Validation error.',
    type: ApiErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'The same category and URL mapping already exists.',
    type: ApiErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Category not found.',
    type: ApiErrorResponseDto,
  })
  createCategoryUrl(@Body() createCategoryUrlDto: CreateCategoryUrlDto) {
    return this.categoriesService.createCategoryUrl(createCategoryUrlDto);
  }

  @Get('urls')
  @ApiOperation({ summary: 'List category URL mappings' })
  @ApiBadRequestResponse({
    description: 'Invalid query parameters.',
    type: ApiErrorResponseDto,
  })
  findAllCategoryUrls(@Query() filterDto: FilterCategoryUrlDto) {
    return this.categoriesService.findAllCategoryUrls(filterDto);
  }

  @Get('urls/:urlId')
  @ApiOperation({ summary: 'Get a category URL mapping by id' })
  @ApiParam({ name: 'urlId', example: 12 })
  @ApiNotFoundResponse({
    description: 'Category URL not found.',
    type: ApiErrorResponseDto,
  })
  findOneCategoryUrl(@Param('urlId', ParseIntPipe) urlId: number) {
    return this.categoriesService.findOneCategoryUrl(urlId);
  }

  @Patch('urls/:urlId')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(...CATEGORY_URL_MANAGER_ROLES)
  @RequireAdminAccess('categories')
  @ApiOperation({ summary: 'Update a category URL mapping' })
  @ApiParam({ name: 'urlId', example: 12 })
  @ApiBody({
    type: UpdateCategoryUrlDto,
    examples: {
      update_url_only: {
        summary: 'Update only the category URL',
        value: {
          url: 'https://store.example.com/displays/oled-monitors',
        },
      },
      update_sort_order: {
        summary: 'Reorder the URL mapping',
        value: {
          sort_order: 1,
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Validation error.',
    type: ApiErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'The same category and URL mapping already exists.',
    type: ApiErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Category URL or category not found.',
    type: ApiErrorResponseDto,
  })
  updateCategoryUrl(
    @Param('urlId', ParseIntPipe) urlId: number,
    @Body() updateCategoryUrlDto: UpdateCategoryUrlDto,
  ) {
    return this.categoriesService.updateCategoryUrl(
      urlId,
      updateCategoryUrlDto,
    );
  }

  @Delete('urls/:urlId')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(...CATEGORY_URL_MANAGER_ROLES)
  @RequireAdminAccess('categories')
  @ApiOperation({ summary: 'Delete a category URL mapping' })
  @ApiParam({ name: 'urlId', example: 12 })
  @ApiNotFoundResponse({
    description: 'Category URL not found.',
    type: ApiErrorResponseDto,
  })
  removeCategoryUrl(@Param('urlId', ParseIntPipe) urlId: number) {
    return this.categoriesService.removeCategoryUrl(urlId);
  }

  @Get(':id/urls')
  @ApiOperation({ summary: 'List category URL mappings for one category' })
  @ApiParam({ name: 'id', example: 9, description: 'Category id' })
  @ApiBadRequestResponse({
    description: 'Invalid query parameters.',
    type: ApiErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Category not found.',
    type: ApiErrorResponseDto,
  })
  findCategoryUrlsByCategory(
    @Param('id', ParseIntPipe) id: number,
    @Query() filterDto: FilterCategoryUrlDto,
  ) {
    return this.categoriesService.findCategoryUrlsByCategory(id, filterDto);
  }

  @Get(':id/vendor-categories')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('categories')
  @ApiOperation({
    summary:
      'List vendor categories mapped to this platform category, grouped by vendor',
  })
  @ApiParam({ name: 'id', example: 9, description: 'Category id' })
  @ApiNotFoundResponse({
    description: 'Category not found.',
    type: ApiErrorResponseDto,
  })
  findVendorCategoriesByCategory(@Param('id', ParseIntPipe) id: number) {
    return this.categoriesService.findVendorCategoriesByCategory(id);
  }

  @Get(':id')
  @UseGuards(OptionalJwtAuthGuard)
  findOne(
    @Param('id') id: number,
    @Query() filterDto: FilterProductDto,
    @Req() req: any,
  ) {
    return this.categoriesService.findOne(
      id,
      filterDto,
      shouldReturnAdminEntityDetail(req.user, filterDto),
    );
  }

  @Get('slug/:slug')
  @UseGuards(OptionalJwtAuthGuard)
  async findOneBySlug(
    @Param('slug') slug: string,
    @Query() filterDto: FilterProductDto,
    @Req() req: any,
  ) {
    return this.categoriesService.findOneBySlug(
      slug,
      filterDto,
      shouldReturnAdminEntityDetail(req.user, filterDto),
    );
  }

  // ========== LIFECYCLE MANAGEMENT ==========

  // Archive a category (soft delete)
  @Post(':id/archive')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('categories')
  archive(@Param('id') id: number, @Request() req) {
    return this.categoriesService.archive(id, req.user.id);
  }

  // Restore a category from archive
  @Post(':id/restore')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('archived')
  restore(@Param('id') id: number, @Body() restoreDto: RestoreCategoryDto) {
    return this.categoriesService.restore(id, restoreDto);
  }

  // Permanently delete a category (hard delete)
  @Delete(':id/permanent')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('archived')
  permanentDelete(
    @Param('id') id: number,
    @Body() options?: PermanentDeleteCategoryDto,
  ) {
    return this.categoriesService.permanentDelete(id, options);
  }

  // Reorder categories
  @Put('reorder')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('categories')
  reorder(@Body() dto: ReorderCategoriesDto) {
    return this.categoriesService.reorder(dto.categories);
  }

  // ========== PRODUCT ASSIGNMENT ==========

  // Assign products to this category
  @Post(':id/products')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('categories')
  assignProducts(
    @Param('id') id: number,
    @Body() dto: AssignProductsToCategoryDto,
  ) {
    return this.categoriesService.assignProducts(id, dto.product_ids);
  }

  // Remove products from this category
  @Delete(':id/products')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('categories')
  removeProducts(
    @Param('id') id: number,
    @Body() dto: AssignProductsToCategoryDto,
  ) {
    return this.categoriesService.removeProducts(id, dto.product_ids);
  }

  // Get products in this category
  @Get(':id/products')
  getProducts(
    @Param('id') id: number,
    @Query() filterDto: FilterProductDto,
  ) {
    return this.categoriesService.getProducts(id, filterDto);
  }

}
