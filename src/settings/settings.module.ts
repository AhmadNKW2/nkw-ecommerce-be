import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Product } from '../products/entities/product.entity';
import { Category } from '../categories/entities/category.entity';
import { Brand } from '../brands/entities/brand.entity';
import { Vendor } from '../vendors/entities/vendor.entity';
import { ProductPriceRule } from './entities/product-price-rule.entity';
import { ProductFieldToggles } from './entities/product-field-toggles.entity';
import { SitePopupSettings } from './entities/site-popup-settings.entity';
import { SeoSettings } from './entities/seo-settings.entity';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { SeoGenerationService } from './seo-generation.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SeoSettings,
      ProductPriceRule,
      ProductFieldToggles,
      SitePopupSettings,
      Product,
      Category,
      Brand,
      Vendor,
    ]),
  ],
  controllers: [SettingsController],
  providers: [SettingsService, SeoGenerationService],
  exports: [SettingsService, SeoGenerationService],
})
export class SettingsModule {}
