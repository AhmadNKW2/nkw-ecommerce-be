import { Observable, timer } from 'rxjs';
import { map, takeWhile, finalize } from 'rxjs/operators';
import {
  Controller,
  Get,
  Post,
  Body,
  Put,
  Param,
  Delete,
  Query,
  UseGuards,
  Patch,
  Req,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
  NotFoundException,
  ForbiddenException,
  Sse,
  MessageEvent
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsString } from 'class-validator';
import { ProductsService } from './products.service';
import { ProductImportService } from './product-import.service';
import { CreateProductDto } from './dto/create-product.dto';
import { DeleteReviewProductsDto } from './dto/delete-review-products.dto';
import { ImportedPricingAuditQueryDto } from './dto/imported-pricing-audit-query.dto';
import { ReimportReviewProductsDto } from './dto/reimport-review-products.dto';
import { BulkUpdateProductStatusDto } from './dto/bulk-update-product-status.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { PatchProductDto } from './dto/patch-product.dto';
import { FilterProductDto, AssignProductsDto } from './dto/filter-product.dto';
import { ProductNamesQueryDto } from './dto/product-names-query.dto';
import { SyncImportedPricingDto } from './dto/sync-imported-pricing.dto';
import { SyncLinkedProductsDto } from './dto/sync-linked-products.dto';
import { MergeDuplicateReferenceSlugsDto } from './dto/merge-duplicate-reference-slugs.dto';
import { Roles, UserRole } from '../common/decorators/roles.decorator';
import { RequireAdminAccess } from '../common/decorators/admin-access.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { RestoreProductDto } from './dto/restore-product.dto';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import {
  applyVendorPortalListScope,
  assertVendorPortalOwnsProduct,
  isSimplifiedProductCreator,
  resolveCreatorVendorId,
} from './utils/simplified-product-creator.util';

class SetProductTagsDto {
  @IsArray()
  @IsString({ each: true })
  tags: string[];
}

class AddProductTagDto {
  @IsString()
  @IsNotEmpty()
  name: string;
}

const PRODUCTS_MANAGER_ROLES = [
  UserRole.ADMIN,
  UserRole.CONSTANT_TOKEN_ADMIN,
  UserRole.VENDOR_ADMIN,
  UserRole.STORE_ADMIN,
] as const;

function assertNotVendorPortalAdminTools(user?: { role?: string } | null) {
  if (isSimplifiedProductCreator(user)) {
    throw new ForbiddenException(
      "You don't have permission to perform this action",
    );
  }
}

function isProductsAdminUser(user?: { role?: string } | null): boolean {
  return (
    user?.role === UserRole.ADMIN ||
    user?.role === UserRole.CONSTANT_TOKEN_ADMIN ||
    user?.role === 'products_api' ||
    isSimplifiedProductCreator(user)
  );
}

@ApiTags('Products')
@Controller('products')
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly productImportService: ProductImportService,
  ) {}

  // ========== PRODUCT CRUD ==========

  @Get('import-jobs/:jobId')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(...PRODUCTS_MANAGER_ROLES)
  @RequireAdminAccess('products')
  @ApiOperation({
    summary: 'Poll the status of a background product import or re-import job',
  })
  getImportJobStatus(@Param('jobId') jobId: string) {
    const status = this.productImportService.getJobStatus(jobId);

    if (!status) {
      throw new NotFoundException(
        `Import job '${jobId}' not found (may have expired after 24 h)`,
      );
    }

    return status;
  }

  @Sse('import-jobs/:jobId/stream')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(...PRODUCTS_MANAGER_ROLES)
  @RequireAdminAccess('products')
  @ApiOperation({
    summary: 'Stream the status of a background product import or re-import job via SSE',
  })
  streamImportJobStatus(@Param('jobId') jobId: string): Observable<MessageEvent> {
    const status = this.productImportService.getJobStatus(jobId);
    if (!status) {
      throw new NotFoundException(`Import job '${jobId}' not found.`);
    }

    return timer(0, 1500).pipe(
      map(() => {
        const currentStatus = this.productImportService.getJobStatus(jobId);
        return { data: currentStatus } as MessageEvent;
      }),
      takeWhile((event) => {
        const payload = event.data as any;
        return payload?.status === 'running';
      }, true),
    );
  }

  @Post('import-payload')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(...PRODUCTS_MANAGER_ROLES)
  @RequireAdminAccess('products')
  @ApiOperation({
    summary: 'Import a raw product payload and create a product through the AI enrichment flow',
  })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: true,
      example: {
        category: {
          id: 9,
          name_en: 'Monitors',
          slug: 'monitors',
          name_ar: 'الشاشات',
          description_en: 'Monitors',
          description_ar: 'الشاشات',
          image:
            'https://pub-b8afad6fa843477fb61b00764b315e24.r2.dev/categories/36af1f8b-04ea-4ae9-a001-bf1fe32cc379.webp',
          level: 0,
          sortOrder: 1,
          status: 'active',
          visible: true,
          parent_id: 'None',
          archived_at: 'None',
          archived_by: 'None',
          createdAt: '2026-03-05T13:41:21.368+03:00',
          updatedAt: '2026-03-16T06:19:24.965+03:00',
        },
        category_ids: [9, 12],
        original_vendor_categories_ids: [44, 51],
        vendor: {
          id: 2,
          slug: 'midas-computer-center',
          name_en: 'Midas Computer Center',
          name_ar: 'ميداس للكمبيوتر',
          description_en: 'Midas Computer Center',
          description_ar: 'ميداس للكمبيوتر',
          email: 'None',
          phone: 'None',
          address: 'None',
          logo:
            'https://pub-b8afad6fa843477fb61b00764b315e24.r2.dev/vendors/bbc6f2da-992a-4b85-b1de-3699c5e9162e.webp',
          status: 'active',
          visible: true,
          rating: '0.00',
          rating_count: 0,
          sort_order: 1,
          archived_at: 'None',
          archived_by: 'None',
          created_at: '2026-02-19T13:07:51.709+03:00',
          updated_at: '2026-02-19T13:07:51.709+03:00',
          deleted_at: 'None',
        },
        vendor_id: 2,
        created_at: '2026-04-07T12:10:45.258+03:00',
        updated_at: '2026-04-07T12:10:45.258+03:00',
        scraping_website_id: '2',
        type: 'new',
        reference_link:
          'https://mcc-jo.com/product/samsung-s3-essential-d362-curved-business-monitor-24-inch-full-hd-100hz-4ms-eye-saver-mode',
        data: {
          reference_link:
            'https://mcc-jo.com/product/samsung-s3-essential-d362-curved-business-monitor-24-inch-full-hd-100hz-4ms-eye-saver-mode',
          title:
            'Samsung S3 Essential D362 Curved Business Monitor - 24-inch Full HD 100Hz 4ms Eye Saver Mode',
          short_description:
            'Samsung S3 Essential D362 Curved Business Monitor - 24-inch Full HD 100Hz 4ms Eye Saver Mode, Color Gamut (sRGB Coverage) 95%',
          description:
            'Samsung S3 Essential D362CurvedBusiness Monitor - 24-inch Full HD 100Hz 4ms Eye Saver Mode1800R Curved Screen | 100Hz Refresh Rate | Game Mode | Eye Saver Mode & Less Screen FlickeringAdditional Features: Color Gamut (sRGB Coverage) 95% | Eco Saving Plus | Off Timer PlusSamsung S3Curved MonitorThe Curved for enriched engagement,1800R Curved ScreenA more immersive viewing experience. The curved monitor wraps more closely around your field of vision to create a wider view which enhances depth perception and minimizes peripheral distractions, helping to better stay focused on what\'s on screen.Smooth performance for your content,100Hz Refresh RateStay in the action when playing games, watching videos, or working on creative projects. The 100Hz refresh rate reduces lag and motion blur so you don\'t miss a thing in fast-paced moments.Game ModeGain the edge with optimizable game settings. Color and image contrast can be instantly adjusted to see scenes more vividly and spot enemies hiding in the dark, while Game Mode adjusts any game to fill your screen with every detail in view.for moreAsus Gaming Laptop',
          old_price: 'None',
          new_price: '89.0',
          brand: 'SAMSUNG',
          image: 4924,
          images: [4925, 4926, 4927, 4928],
          specification: [
            {
              key: 'Screen Size',
              value: ['24-inch'],
            },
            {
              key: 'Screen Refresh Rate',
              value: ['100 Hz'],
            },
            {
              key: 'Screen Resolution',
              value: ['1920x1080 (FHD)'],
            },
            {
              key: 'Screen Panel Technology',
              value: ['VA'],
            },
            {
              key: 'Response Time',
              value: ['4ms'],
            },
            {
              key: 'Contrast Ratio',
              value: ['3000:1'],
            },
            {
              key: 'Brightness',
              value: ['250 nits'],
            },
            {
              key: 'Flat / Curved',
              value: ['Curved'],
            },
            {
              key: 'Speakers',
              value: ['N/A'],
            },
            {
              key: 'Color support',
              value: ['8-bit (16.7 million colors)', '95% DCI-P3'],
            },
            {
              key: 'Ports',
              value: ['1x HDMI', '1x D-Sub (VGA)'],
            },
            {
              key: 'BRAND',
              value: ['SAMSUNG'],
            },
            {
              key: 'Warranty',
              value: ['3-YEAR'],
            },
          ],
          attributes: {},
          in_stock: true,
        },
      },
    },
    description:
      'Send the raw product payload directly in the request body. Use category_ids to assign the imported product to multiple categories; the first category is still used as the primary AI catalog category. You can also send original_vendor_categories_ids when only source vendor category IDs are available.',
  })
  importPayload(@Body() body: Record<string, unknown>, @Req() req: any) {
    return this.productImportService.importFromRequest(body, req.user?.id);
  }

  @Post()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(...PRODUCTS_MANAGER_ROLES)
  @RequireAdminAccess('products')
  @ApiOperation({ summary: 'Create a product' })
  @ApiBody({
    type: CreateProductDto,
    description: 'Full product payload having everything',
    examples: {
      default: {
        summary: 'Full payload example',
        value: {
          name_en: 'ASD Gaming Mouse',
          name_ar: 'ماوس ألعاب ASD',
          sku: 'ASD-MOUSE-001',
          record: 'MIGRATED_FROM_OLD_DB_123',
          status: 'active',
          short_description_en: '<p>Lightweight gaming mouse with configurable options.</p>',
          short_description_ar: '<p>ماوس ألعاب خفيف مع خيارات قابلة للتخصيص.</p>',
          long_description_en: '<p>Premium gaming mouse designed for precision, speed, and comfort.</p>',
          long_description_ar: '<p>ماوس ألعاب احترافي مصمم للدقة والسرعة والراحة.</p>',
          category_ids: [35],
          reference_link: 'https://mcc-jo.com/category/mouse',
          vendor_id: 2,
          brand_id: 34,
          visible: true,
          cost: 30.5,
          price: 50.99,
          sale_price: 45.25,
          weight: 0.25,
          length: 12,
          width: 6,
          height: 4,
          quantity: 100,
          low_stock_threshold: 10,
          is_out_of_stock: false,
          meta_title_en: 'ASD Gaming Mouse | Storefront',
          meta_title_ar: 'ماوس ألعاب ASD | المتجر الإلكتروني',
          meta_description_en:
            'Shop the ASD gaming mouse with configurable variants and premium performance.',
          meta_description_ar:
            'تسوّق ماوس الألعاب ASD مع خيارات متعددة وأداء مميز.',
          specifications: [
            {
              specification_id: 11,
              specification_value_ids: [65, 64],
            },
            {
              specification_id: 1,
              specification_value_ids: [57],
            },
          ],
          attributes: [
            {
              attribute_id: 3,
              attribute_value_ids: [6],
            },
            {
              attribute_id: 10,
              attribute_value_ids: [29],
            },
            {
              attribute_id: 11,
              attribute_value_ids: [30],
            },
            {
              attribute_id: 12,
              attribute_value_ids: [40],
            },
          ],
          media: [
            {
              media_id: 3172,
              is_primary: true,
              sort_order: 0,
            },
            {
              media_id: 3173,
              is_primary: false,
              sort_order: 1,
            },
          ],
          linked_product_ids: [41, 42],
          tags: ['gaming', 'mouse', 'rgb'],
        }
      }
    },
  })
  create(@Body() createProductDto: CreateProductDto, @Req() req: any) {
    return this.productsService.create(createProductDto, req.user?.id, req.user);
  }

  @Patch('bulk-status')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(...PRODUCTS_MANAGER_ROLES)
  @RequireAdminAccess('products')
  @ApiOperation({ summary: 'Bulk update product workflow status' })
  bulkUpdateProductStatus(@Body() dto: BulkUpdateProductStatusDto, @Req() req: any) {
    assertNotVendorPortalAdminTools(req.user);
    return this.productsService.bulkUpdateProductStatus(dto);
  }

  @Put('linked-products')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(...PRODUCTS_MANAGER_ROLES)
  @RequireAdminAccess('products')
  @ApiOperation({ summary: 'Sync a linked products group' })
  syncLinkedProducts(@Body() dto: SyncLinkedProductsDto) {
    return this.productsService.syncProductsGroup(dto.product_ids);
  }

  @Get('names')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'Get products ids and names only' })
  @ApiQuery({
    name: 'vendor_id',
    required: false,
    type: Number,
    description: 'Filter products by vendor id',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Filter products by product name in English or Arabic',
  })
  @ApiQuery({
    name: 'category_ids',
    required: false,
    type: String,
    description: 'Comma separated list of category ids, e.g. 1,2,3',
    example: '1,2,3',
  })
  findProductNames(@Query() queryDto: ProductNamesQueryDto, @Req() req: any) {
    const isAdmin = isProductsAdminUser(req.user);
    const scopedQuery = applyVendorPortalListScope(queryDto as any, req.user);
    return this.productsService.findProductNames(scopedQuery, isAdmin);
  }

  @Get('content')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({
    summary:
      'Get products with id, names, long descriptions, and image URLs only',
  })
  findProductContent(@Query() filterDto: FilterProductDto, @Req() req: any) {
    const isAdmin = isProductsAdminUser(req.user);
    const scopedFilters = applyVendorPortalListScope(filterDto as any, req.user);
    return this.productsService.findProductContent(scopedFilters, isAdmin);
  }

  @Get()
  @UseGuards(OptionalJwtAuthGuard)
  @ApiQuery({
    name: 'vendorId',
    required: false,
    type: Number,
    description: 'Preferred single-vendor filter parameter',
    example: 2,
  })
  @ApiQuery({
    name: 'vendor_id',
    required: false,
    type: Number,
    description: 'Backward-compatible alias for vendorId',
    example: 2,
  })
  @ApiQuery({
    name: 'originalVendorCategoryId',
    required: false,
    type: Number,
    description: 'Preferred original source vendor-category filter parameter',
    example: 18,
  })
  @ApiQuery({
    name: 'original_vendor_category_id',
    required: false,
    type: Number,
    description: 'Backward-compatible alias for originalVendorCategoryId',
    example: 18,
  })
  @ApiQuery({
    name: 'category_ids',
    required: false,
    type: String,
    description: 'Comma separated category ids, e.g. 1,2,3',
    example: '1,2,3',
  })
  @ApiQuery({
    name: 'categories_ids',
    required: false,
    type: String,
    description: 'Alias for category_ids',
    example: '1,2,3',
  })
  @ApiQuery({
    name: 'attributes_ids',
    required: false,
    type: String,
    description: 'Comma separated attribute ids, e.g. 5,8',
    example: '5,8',
  })
  @ApiQuery({
    name: 'attributes_values_ids',
    required: false,
    type: String,
    description: 'Comma separated attribute value ids, e.g. 12,15',
    example: '12,15',
  })
  @ApiQuery({
    name: 'specifications_ids',
    required: false,
    type: String,
    description: 'Comma separated specification ids, e.g. 3,4',
    example: '3,4',
  })
  @ApiQuery({
    name: 'specifications_values_ids',
    required: false,
    type: String,
    description: 'Comma separated specification value ids, e.g. 21,22',
    example: '21,22',
  })
  @ApiQuery({
    name: 'has_duplicate_reference_link',
    required: false,
    type: Boolean,
    description:
      'Filter products by whether their reference_link is duplicated across other products',
    example: true,
  })
  @ApiQuery({
    name: 'has_no_reference_link',
    required: false,
    type: Boolean,
    description:
      'Filter products that have no reference_link (null or empty)',
    example: true,
  })
  findAll(@Query() filterDto: FilterProductDto, @Req() req: any) {
    const isAdmin = isProductsAdminUser(req.user);
    const scopedFilters = applyVendorPortalListScope(filterDto as any, req.user);
    return this.productsService.findAll(scopedFilters, isAdmin);
  }

  @Get('vendor/:vendorId')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'Get products by vendor' })
  findAllByVendor(
    @Param('vendorId', ParseIntPipe) vendorId: number,
    @Query() filterDto: FilterProductDto,
    @Req() req: any,
  ) {
    const isAdmin = isProductsAdminUser(req.user);
    const portalVendorId = resolveCreatorVendorId(req.user);
    if (
      isSimplifiedProductCreator(req.user) &&
      portalVendorId != null &&
      portalVendorId !== vendorId
    ) {
      throw new NotFoundException('Vendor not found');
    }

    const scopedFilters = applyVendorPortalListScope(
      {
        ...filterDto,
        vendorId,
        vendor_ids: undefined,
      } as any,
      req.user,
    );

    return this.productsService.findAll(scopedFilters, isAdmin);
  }

  @Get('reference-link')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'Get a product by reference link and/or reference slug' })
  @ApiQuery({
    name: 'reference_link',
    required: false,
    example: 'https://example.com/products/lg-ultragear-39gx90sa',
  })
  @ApiQuery({
    name: 'reference_slug',
    required: false,
    example: 'lg-ultragear-39gx90sa',
  })
  findOneByReferenceLink(
    @Query('reference_link') referenceLink: string,
    @Query('reference_slug') referenceSlug: string,
    @Req() req: any,
  ) {
    assertNotVendorPortalAdminTools(req.user);
    const isAdmin =
      req.user?.role === UserRole.ADMIN ||
      req.user?.role === UserRole.CONSTANT_TOKEN_ADMIN ||
      req.user?.role === 'products_api';
    return this.productsService.findOneByReferenceLink(
      referenceLink,
      isAdmin,
      referenceSlug,
    );
  }

  @Post('merge-duplicate-reference-slugs')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('products')
  @ApiOperation({
    summary:
      'Merge products that share the same vendor and reference_slug, keeping the lowest product ID',
  })
  @ApiBody({ type: MergeDuplicateReferenceSlugsDto })
  mergeDuplicateReferenceSlugs(@Body() dto: MergeDuplicateReferenceSlugsDto, @Req() req: any) {
    assertNotVendorPortalAdminTools(req.user);
    return this.productsService.mergeDuplicateReferenceSlugs(dto);
  }

  @Get('slug-redirect/:slug')
  @HttpCode(HttpStatus.OK)
  async getSlugRedirect(@Param('slug') slug: string) {
    const redirect = await this.productsService.findSlugRedirect(slug);
    if (!redirect) {
      throw new NotFoundException('No redirect found for this slug');
    }
    return { new_slug: redirect.new_slug };
  }

  @Get(':id')
  @UseGuards(OptionalJwtAuthGuard)
  async findOne(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    const isAdmin = isProductsAdminUser(req.user);
    const product = await this.productsService.findOne(id, isAdmin);
    assertVendorPortalOwnsProduct(product?.vendor_id ?? product?.vendor?.id, req.user);
    return product;
  }

  @Get('slug/:slug')
  @UseGuards(OptionalJwtAuthGuard)
  findOneBySlug(@Param('slug') slug: string, @Req() req: any) {
    const isAdmin =
      req.user?.role === UserRole.ADMIN ||
      req.user?.role === UserRole.CONSTANT_TOKEN_ADMIN ||
      req.user?.role === 'products_api';
    return this.productsService.findOneBySlug(slug, isAdmin);
  }

  @Put(':id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(...PRODUCTS_MANAGER_ROLES)
  @RequireAdminAccess('products')
  @ApiOperation({ summary: 'Replace a product' })
  @ApiBody({
    type: UpdateProductDto,
    examples: {
      replace_specifications: {
        summary: 'Replace product fields including specifications',
        value: {
          name_en: 'LG UltraGear WOLED Gaming Monitor 39-inch',
          name_ar: 'LG UltraGear WOLED Gaming Monitor 39-inch',
          short_description_en: 'Gaming monitor with OLED panel',
          short_description_ar: 'Gaming monitor with OLED panel',
          long_description_en: 'Detailed product description',
          long_description_ar: 'Detailed product description',
          category_ids: [9],
          reference_link: 'https://mcc-jo.com/category/monitors',
          vendor_id: 2,
          brand_id: 34,
          visible: true,
          cost: 1200,
          price: 1585.9,
          sale_price: 1499.9,
          weight: 10.5,
          length: 93.5,
          width: 28.4,
          height: 61.2,
          quantity: 8,
          low_stock_threshold: 3,
          is_out_of_stock: false,
          meta_title_en: 'LG UltraGear WOLED Gaming Monitor 39-inch | Storefront',
          meta_title_ar: 'شاشة LG UltraGear WOLED مقاس 39 بوصة | المتجر الإلكتروني',
          meta_description_en:
            'Buy the LG UltraGear 39-inch WOLED gaming monitor with premium display performance.',
          meta_description_ar:
            'اشترِ شاشة LG UltraGear WOLED مقاس 39 بوصة بأداء عرض مميز للألعاب.',
          media: [
            { media_id: 3172, is_primary: true, sort_order: 0 },
            { media_id: 3173, is_primary: false, sort_order: 1 },
          ],
          specifications: [
            { specification_id: 1, specification_value_ids: [60] },
            { specification_id: 4, specification_value_ids: [7, 39] },
            { specification_id: 8, specification_value_ids: [50] },
            { specification_id: 9, specification_value_ids: [49] },
            { specification_id: 10, specification_value_ids: [35] },
            { specification_id: 11, specification_value_ids: [67] },
          ],
          linked_product_ids: [50, 51],
          tags: ['monitor', 'oled', 'gaming'],
        },
      },
      replace_attributes_and_specifications: {
        summary: 'Replace attributes and specifications together',
        value: {
          name_en: 'Gaming Mouse Pro',
          name_ar: 'Gaming Mouse Pro',
          short_description_en: 'Wireless gaming mouse',
          short_description_ar: 'Wireless gaming mouse',
          long_description_en: 'Detailed gaming mouse description',
          long_description_ar: 'Detailed gaming mouse description',
          category_ids: [9],
          reference_link: 'https://mcc-jo.com/category/gaming-mice',
          vendor_id: 2,
          brand_id: 34,
          visible: true,
          cost: 70,
          price: 129.9,
          sale_price: 119.9,
          weight: 0.12,
          length: 12,
          width: 6.5,
          height: 4,
          quantity: 45,
          low_stock_threshold: 5,
          is_out_of_stock: false,
          meta_title_en: 'Gaming Mouse Pro | Storefront',
          meta_title_ar: 'ماوس الألعاب برو | المتجر الإلكتروني',
          meta_description_en:
            'Upgrade to the Gaming Mouse Pro with refined specs and accessory options.',
          meta_description_ar:
            'طوّر تجربتك مع Gaming Mouse Pro بمواصفات محسّنة وخيارات إضافية.',
          attributes: [
            {
              attribute_id: 21,
              attribute_value_ids: [101],
            },
          ],
          media: [
            { media_id: 4101, is_primary: true, sort_order: 0 },
            { media_id: 4102, is_primary: false, sort_order: 1 },
          ],
          specifications: [
            { specification_id: 4, specification_value_ids: [39] },
            { specification_id: 11, specification_value_ids: [67] },
          ],
          linked_product_ids: [12, 18, 27],
          tags: ['gaming', 'mouse', 'wireless'],
        },
      },
    },
  })
  update(
    @Param('id') id: string,
    @Body() updateProductDto: UpdateProductDto,
    @Req() req: any,
  ) {
    return this.productsService.update(+id, updateProductDto, req.user);
  }

  @Patch(':id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(...PRODUCTS_MANAGER_ROLES)
  @RequireAdminAccess('products')
  @ApiOperation({ summary: 'Partially update a product' })
  @ApiBody({
    type: PatchProductDto,
    examples: {
      only_specifications: {
        summary: 'Update only product specifications',
        value: {
          specifications: [
            { specification_id: 1, specification_value_ids: [60] },
            { specification_id: 4, specification_value_ids: [7, 8, 39] },
            { specification_id: 8, specification_value_ids: [50] },
            { specification_id: 9, specification_value_ids: [49] },
            { specification_id: 10, specification_value_ids: [35] },
            { specification_id: 11, specification_value_ids: [67] },
          ],
        },
      },
      attributes_and_specifications: {
        summary: 'Update attributes and specifications together',
        value: {
          reference_link: 'https://mcc-jo.com/category/gaming-mice',
          attributes: [
            {
              attribute_id: 21,
              attribute_value_ids: [101],
            },
          ],
          specifications: [
            { specification_id: 4, specification_value_ids: [39] },
            { specification_id: 11, specification_value_ids: [67] },
          ],
          media: [
            { media_id: 4101, is_primary: true, sort_order: 0 },
            { media_id: 4102, is_primary: false, sort_order: 1 },
          ],
          price: 129.9,
          sale_price: 119.9,
          quantity: 45,
          weight: 0.12,
          length: 12,
          width: 6.5,
          height: 4,
          is_out_of_stock: false,
          linked_product_ids: [12, 18, 27],
          tags: ['gaming', 'mouse', 'wireless'],
        },
      },
      clear_specifications: {
        summary: 'Remove all product specifications',
        value: {
          specifications: [],
        },
      },
      seo_only: {
        summary: 'Update only SEO fields',
        value: {
          meta_title_en: 'Wireless Headphones | Storefront',
          meta_title_ar: 'سماعات لاسلكية | المتجر الإلكتروني',
          meta_description_en:
            'Buy the best wireless headphones with ANC technology.',
          meta_description_ar:
            'اشترِ أفضل السماعات اللاسلكية بتقنية إلغاء الضوضاء.',
        },
      },
      reference_slug_only: {
        summary: 'Update only the reference slug',
        value: {
          reference_slug: 'samsung-s3-essential-d362-curved-monitor',
        },
      },
      original_price_only: {
        summary: 'Update original price and auto-recalculate managed price',
        value: {
          original_price: 60,
        },
      },
      original_prices_with_sale: {
        summary: 'Update original price and original sale price',
        value: {
          original_price: 100,
          original_sale_price: 85,
        },
      },
    },
  })
  patch(
    @Param('id', ParseIntPipe) id: number,
    @Body() patchProductDto: PatchProductDto,
    @Req() req: any,
  ) {
    return this.productsService.update(
      id,
      patchProductDto as UpdateProductDto,
      req.user,
    );
  }

  // ========== LIFECYCLE MANAGEMENT ==========

  @Post(':id/archive')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(...PRODUCTS_MANAGER_ROLES)
  @RequireAdminAccess('products')
  archive(@Param('id') id: string, @Req() req: any) {
    return this.productsService.archive(+id, req.user.id);
  }

  @Post(':id/restore')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(...PRODUCTS_MANAGER_ROLES)
  @RequireAdminAccess('archived')
  restore(@Param('id') id: string, @Body() dto: RestoreProductDto) {
    return this.productsService.restore(+id, dto.newCategoryId);
  }

  @Get('archive/list')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(...PRODUCTS_MANAGER_ROLES)
  @RequireAdminAccess('archived')
  findArchived(@Query() filterDto: FilterProductDto) {
    return this.productsService.findArchived(filterDto);
  }

  @Delete('review/permanent')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('products')
  @ApiOperation({
    summary: 'Permanently delete review products by category and vendor',
  })
  @ApiBody({
    type: DeleteReviewProductsDto,
    description:
      'Deletes every product whose status is review and matches both the given category and vendor.',
    examples: {
      default: {
        summary: 'Delete review products for one vendor/category pair',
        value: {
          category_id: 35,
          vendor_id: 2,
        },
      },
    },
  })
  @ApiOkResponse({
    description: 'Review products permanently deleted',
    schema: {
      example: {
        message: 'Deleted 4 review products for vendor "Tech Vendor" in category "Gaming"',
        deleted: 4,
        filters: {
          status: 'review',
          category_id: 35,
          vendor_id: 2,
        },
      },
    },
  })
  permanentDeleteReviewProducts(@Body() dto: DeleteReviewProductsDto) {
    return this.productsService.permanentDeleteReviewProducts(
      dto.category_id,
      dto.vendor_id,
    );
  }

  @Post('review/reimport-ai')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(...PRODUCTS_MANAGER_ROLES)
  @RequireAdminAccess('products')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Re-import review products by category and vendor using their stored input_json payloads',
  })
  @ApiBody({
    type: DeleteReviewProductsDto,
    description:
      'Re-imports every product whose status is review and matches both the given category and vendor.',
    examples: {
      filtered: {
        summary: 'Re-import review products for one vendor/category pair',
        value: {
          category_id: 35,
          vendor_id: 2,
        },
      },
      allReviewProducts: {
        summary: 'Re-import all review products',
        value: {},
      },
    },
  })
  @ApiOkResponse({
    description: 'Review products re-imported',
    schema: {
      example: {
        job_id: 'reimport-review-1746800000000-ab123',
        message:
          'Review product re-import started in background. Matching review products will be processed one by one. Poll GET /products/import-jobs/:job_id to track progress.',
      },
    },
  })
  reimportReviewProducts(@Body() dto: ReimportReviewProductsDto, @Req() req: any) {
    assertNotVendorPortalAdminTools(req.user);
    const jobId = this.productImportService.startReimportReviewProductsInBackground(
      dto.category_id,
      dto.vendor_id,
    );

    return {
      job_id: jobId,
      message:
        'Review product re-import started in background. Matching review products will be processed one by one. Poll GET /products/import-jobs/:job_id to track progress.',
    };
  }


  @Get('import-pricing/audit')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(...PRODUCTS_MANAGER_ROLES)
  @RequireAdminAccess('product_pricing')
  @ApiOperation({
    summary:
      'Audit imported-product pricing by recomputing prices from product_input_jsons.input_json',
  })
  auditImportedPricing(
    @Query() query: ImportedPricingAuditQueryDto,
  ): Promise<unknown> {
    return this.productImportService.auditImportedPricing({
      page: query.page,
      limit: query.limit,
      mismatchOnly: query.mismatch_only,
      productIds: query.product_ids,
    });
  }

  @Post('import-pricing/sync')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('product_pricing')
  @ApiOperation({
    summary:
      'Dry-run or sync imported-product pricing from product_input_jsons.input_json for selected product ids',
  })
  @ApiBody({ type: SyncImportedPricingDto })
  syncImportedPricing(@Body() dto: SyncImportedPricingDto): Promise<unknown> {
    return this.productImportService.syncImportedPricing(dto);
  }

  @Post(':id/reimport-ai')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(...PRODUCTS_MANAGER_ROLES)
  @RequireAdminAccess('products')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Re-import an existing product by rerunning the AI import flow against its stored input_json payload',
  })
  reimportAiProduct(@Param('id', ParseIntPipe) id: number) {
    const jobId = this.productImportService.startReimportByProductIdInBackground(id);

    return {
      job_id: jobId,
      message:
        'Product re-import started in background. Poll GET /products/import-jobs/:job_id to track progress.',
    };
  }

  @Delete(':id/permanent')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('archived')
  permanentDelete(@Param('id') id: string) {
    return this.productsService.permanentDelete(+id);
  }

  // ========== BULK ASSIGNMENT ==========

  @Post('assign/category/:categoryId')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(...PRODUCTS_MANAGER_ROLES)
  @RequireAdminAccess('products')
  assignToCategory(
    @Param('categoryId') categoryId: string,
    @Body() dto: AssignProductsDto,
  ) {
    return this.productsService.assignProductsToCategory(
      +categoryId,
      dto.product_ids,
    );
  }

  @Delete('assign/category/:categoryId')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(...PRODUCTS_MANAGER_ROLES)
  @RequireAdminAccess('products')
  removeFromCategory(
    @Param('categoryId') categoryId: string,
    @Body() dto: AssignProductsDto,
  ) {
    return this.productsService.removeProductsFromCategory(
      +categoryId,
      dto.product_ids,
    );
  }

  @Post('assign/vendor/:vendorId')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(...PRODUCTS_MANAGER_ROLES)
  @RequireAdminAccess('products')
  assignToVendor(
    @Param('vendorId') vendorId: string,
    @Body() dto: AssignProductsDto,
  ) {
    return this.productsService.assignProductsToVendor(
      +vendorId,
      dto.product_ids,
    );
  }

  @Delete('assign/vendor/:vendorId')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(...PRODUCTS_MANAGER_ROLES)
  @RequireAdminAccess('products')
  removeFromVendor(
    @Param('vendorId') vendorId: string,
    @Body() dto: AssignProductsDto,
  ) {
    return this.productsService.removeProductsFromVendor(
      +vendorId,
      dto.product_ids,
    );
  }

  // ========== PRODUCT TAG MANAGEMENT ==========

  /**
   * GET /products/:id/tags
   * Returns all tags attached to the product with their linked concepts.
   */
  @Get(':id/tags')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(...PRODUCTS_MANAGER_ROLES)
  @RequireAdminAccess('products')
  getProductTags(@Param('id', ParseIntPipe) id: number) {
    return this.productsService.getProductTags(id);
  }

  /**
   * PUT /products/:id/tags
   * Replaces the full tag list for a product.
   * Pass tags: [] to clear all tags.
   * Each name is normalised and created if it does not exist yet.
   */
  @Put(':id/tags')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(...PRODUCTS_MANAGER_ROLES)
  @RequireAdminAccess('products')
  setProductTags(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetProductTagsDto,
  ) {
    return this.productsService.syncProductTags(id, dto.tags);
  }

  /**
   * POST /products/:id/tags
   * Adds a single tag (by name) to the product.
   * Creates the tag + fires AI concept generation if brand-new.
   */
  @Post(':id/tags')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(...PRODUCTS_MANAGER_ROLES)
  @RequireAdminAccess('products')
  addProductTag(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AddProductTagDto,
  ) {
    return this.productsService.addProductTagByName(id, dto.name);
  }

  /**
   * DELETE /products/:id/tags/:tagId
   * Removes a single tag (by its numeric ID) from the product.
   */
  @Delete(':id/tags/:tagId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(...PRODUCTS_MANAGER_ROLES)
  @RequireAdminAccess('products')
  removeProductTag(
    @Param('id', ParseIntPipe) id: number,
    @Param('tagId', ParseIntPipe) tagId: number,
  ) {
    return this.productsService.removeProductTag(id, tagId);
  }
}
