import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Product } from '../products/entities/product.entity';
import { ProductPriceRule } from './entities/product-price-rule.entity';
import { ProductFieldToggles } from './entities/product-field-toggles.entity';
import { SitePopupSettings } from './entities/site-popup-settings.entity';
import { SeoSettings } from './entities/seo-settings.entity';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SeoSettings,
      ProductPriceRule,
      ProductFieldToggles,
      SitePopupSettings,
      Product,
    ]),
  ],
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}