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
import { BulkUpdateProductPricingDto } from './dto/bulk-update-product-pricing.dto';
import { CreateProductPriceRuleDto } from './dto/create-product-price-rule.dto';
import { UpdateProductPriceRuleDto } from './dto/update-product-price-rule.dto';
import { UpdateSeoSettingsDto } from './dto/update-seo-settings.dto';
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

  @Post('pricing-rules/bulk-update')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  bulkUpdateProductPricing(@Body() dto: BulkUpdateProductPricingDto) {
    return this.settingsService.bulkUpdateProductPricing(dto);
  }
}