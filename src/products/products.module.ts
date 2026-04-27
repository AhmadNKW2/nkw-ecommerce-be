import { Module, OnModuleInit, forwardRef } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { Product } from './entities/product.entity';
import { ProductAttribute } from './entities/product-attribute.entity';
import { ProductCategory } from './entities/product-category.entity';
import { ProductSpecificationValue } from './entities/product-specification-value.entity';
import { ProductAttributeValue } from './entities/product-attribute-value.entity';
import { ProductGroup } from './entities/product-group.entity';
import { GroupProduct } from './entities/group-product.entity';
import { ProductMedia } from './entities/product-media.entity';
import { AttributesModule } from '../attributes/attributes.module';
import { AttributeValue } from '../attributes/entities/attribute-value.entity';
import { Attribute } from '../attributes/entities/attribute.entity';
import { Media } from '../media/entities/media.entity';
import { MediaModule } from '../media/media.module';
import { Category } from '../categories/entities/category.entity';
import { Brand } from '../brands/entities/brand.entity';
import { SearchModule } from '../search/search.module';
import { SearchProcessor } from '../search/search.processor';
import { CartItem } from '../cart/entities/cart-item.entity';
import { Tag } from '../search/entities/tag.entity';
import { ProductSlugRedirect } from './entities/product-slug-redirect.entity';
import { SpecificationsModule } from '../specifications/specifications.module';
import { ProductImportService } from './product-import.service';
import { ProductMediaBackfillService } from './product-media-backfill.service';
import { BrandsModule } from '../brands/brands.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Product,
      ProductAttribute,
      ProductAttributeValue,
      ProductCategory,
      ProductMedia,
      ProductSpecificationValue,
      ProductGroup,
      GroupProduct,
      AttributeValue,
      Attribute,
      Media,
      Category,
      Brand,
      CartItem,
      Tag,
      ProductSlugRedirect,
    ]),
    AttributesModule,
    SpecificationsModule,
    MediaModule,
    forwardRef(() => BrandsModule),
    forwardRef(() => SearchModule),
  ],
  controllers: [ProductsController],
  providers: [
    ProductsService,
    ProductImportService,
    ProductMediaBackfillService,
  ],
  exports: [
    ProductsService,
  ],
})
export class ProductsModule implements OnModuleInit {
  constructor(private readonly moduleRef: ModuleRef) {}

  onModuleInit() {
    // Wire ProductsService into SearchProcessor to break the circular dependency.
    // SearchProcessor lives in SearchModule but needs ProductsService.
    try {
      const processor = this.moduleRef.get(SearchProcessor, { strict: false });
      const productsService = this.moduleRef.get(ProductsService, {
        strict: false,
      });
      processor.setProductsService(productsService);
    } catch {
      // SearchProcessor may not be available in all test environments
    }
  }
}
