import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Roles, UserRole } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CreateProductPriceRuleDto } from './dto/create-product-price-rule.dto';
import { UpdateProductPriceRuleDto } from './dto/update-product-price-rule.dto';
import { UpdateProductFieldTogglesDto } from './dto/product-field-toggles.dto';
import { UpdateSeoSettingsDto } from './dto/update-seo-settings.dto';
import { UpdateSitePopupSettingsDto } from './dto/update-site-popup-settings.dto';
import { SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get('seo')
  getSeoSettings() {
    return this.settingsService.getSeoSettings();
  }

  @Patch('seo')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  updateSeoSettings(@Body() updateSeoSettingsDto: UpdateSeoSettingsDto) {
    return this.settingsService.updateSeoSettings(updateSeoSettingsDto);
  }

  @Get('features')
  getFeatureToggles() {
    return this.settingsService.getProductFieldToggles();
  }

  @Patch('features')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
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
  updateSitePopupSettings(@Body() updateSitePopupSettingsDto: UpdateSitePopupSettingsDto) {
    return this.settingsService.updateSitePopupSettings(updateSitePopupSettingsDto);
  }

  @Get('pricing-rules')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  getProductPriceRules() {
    return this.settingsService.getProductPriceRules();
  }

  @Post('pricing-rules')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  createProductPriceRule(@Body() dto: CreateProductPriceRuleDto) {
    return this.settingsService.createProductPriceRule(dto);
  }

  @Patch('pricing-rules/:id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  updateProductPriceRule(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateProductPriceRuleDto,
  ) {
    return this.settingsService.updateProductPriceRule(id, dto);
  }

  @Delete('pricing-rules/:id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  deleteProductPriceRule(@Param('id', ParseIntPipe) id: number) {
    return this.settingsService.deleteProductPriceRule(id);
  }

  @Post('pricing-rules/reprice-existing')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  repriceExistingProducts() {
    return this.settingsService.repriceExistingProductsByFixedPercentage();
  }
}