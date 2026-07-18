import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Roles, UserRole } from '../common/decorators/roles.decorator';
import { RequireAdminAccess } from '../common/decorators/admin-access.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CreateProductPriceRuleDto } from './dto/create-product-price-rule.dto';
import { UpdateProductPriceRuleDto } from './dto/update-product-price-rule.dto';
import { UpdateProductFieldTogglesDto } from './dto/product-field-toggles.dto';
import { UpdateSeoSettingsDto } from './dto/update-seo-settings.dto';
import { UpdateSitePopupSettingsDto } from './dto/update-site-popup-settings.dto';
import { ListMissingSeoDto } from './dto/list-missing-seo.dto';
import { GenerateSeoDto } from './dto/generate-seo.dto';
import { SettingsService } from './settings.service';
import { SeoGenerationService } from './seo-generation.service';

@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly seoGenerationService: SeoGenerationService,
  ) {}

  @Get('seo')
  getSeoSettings() {
    return this.settingsService.getSeoSettings();
  }

  @Patch('seo')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('settings')
  updateSeoSettings(@Body() updateSeoSettingsDto: UpdateSeoSettingsDto) {
    return this.settingsService.updateSeoSettings(updateSeoSettingsDto);
  }

  @Get('seo/missing')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('settings')
  listMissingSeo(@Query() query: ListMissingSeoDto) {
    return this.seoGenerationService.listMissing(query);
  }

  @Post('seo/generate')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('settings')
  generateSeo(@Body() dto: GenerateSeoDto) {
    const { job_id } = this.seoGenerationService.startGenerateInBackground(dto);
    return {
      job_id,
      message:
        'SEO generation started in background. Poll GET /settings/seo/jobs/:job_id to track progress.',
    };
  }

  @Get('seo/jobs/:jobId')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('settings')
  getSeoJobStatus(@Param('jobId') jobId: string) {
    const status = this.seoGenerationService.getJobStatus(jobId);
    if (!status) {
      throw new NotFoundException(`SEO job ${jobId} not found`);
    }
    return status;
  }

  @Get('features')
  getFeatureToggles() {
    return this.settingsService.getProductFieldToggles();
  }

  @Patch('features')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('settings')
  updateFeatureToggles(
    @Body() updateProductFieldTogglesDto: UpdateProductFieldTogglesDto,
  ) {
    return this.settingsService.updateProductFieldToggles(
      updateProductFieldTogglesDto,
    );
  }

  @Get('product-fields')
  getProductFieldToggles() {
    return this.settingsService.getProductFieldToggles();
  }

  @Patch('product-fields')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('settings')
  updateProductFieldToggles(
    @Body() updateProductFieldTogglesDto: UpdateProductFieldTogglesDto,
  ) {
    return this.settingsService.updateProductFieldToggles(
      updateProductFieldTogglesDto,
    );
  }

  @Get('popup')
  getSitePopupSettings() {
    return this.settingsService.getSitePopupSettings();
  }

  @Patch('popup')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('settings')
  updateSitePopupSettings(@Body() updateSitePopupSettingsDto: UpdateSitePopupSettingsDto) {
    return this.settingsService.updateSitePopupSettings(updateSitePopupSettingsDto);
  }

  @Get('pricing-rules')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('settings')
  getProductPriceRules() {
    return this.settingsService.getProductPriceRules();
  }

  @Post('pricing-rules')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('settings')
  createProductPriceRule(@Body() dto: CreateProductPriceRuleDto) {
    return this.settingsService.createProductPriceRule(dto);
  }

  @Patch('pricing-rules/:id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('settings')
  updateProductPriceRule(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateProductPriceRuleDto,
  ) {
    return this.settingsService.updateProductPriceRule(id, dto);
  }

  @Delete('pricing-rules/:id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('settings')
  deleteProductPriceRule(@Param('id', ParseIntPipe) id: number) {
    return this.settingsService.deleteProductPriceRule(id);
  }

  @Post('pricing-rules/reprice-existing')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  @RequireAdminAccess('settings')
  repriceExistingProducts() {
    return this.settingsService.repriceExistingProductsByFixedPercentage();
  }
}