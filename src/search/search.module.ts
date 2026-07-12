import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SearchService } from './search.service';
import { SearchCacheService } from './search-cache.service';
import { AdminSearchController } from './admin-search.controller';
import { TagsService } from './tags.service';
import { SearchController } from './search.controller';
import { AdminTagsController } from './admin-tags.controller';
import { Tag } from './entities/tag.entity';
import { Category } from '../categories/entities/category.entity';
import { Brand } from '../brands/entities/brand.entity';
import { Vendor } from '../vendors/entities/vendor.entity';
import { AttributeValue } from '../attributes/entities/attribute-value.entity';
import { SpecificationValue } from '../specifications/entities/specification-value.entity';
import { Product } from '../products/entities/product.entity';
import { ProductAttributeValue } from '../products/entities/product-attribute-value.entity';
import { ProductSpecificationValue } from '../products/entities/product-specification-value.entity';
import { ProductsModule } from '../products/products.module';
import { TypesenseBackfillService } from '../typesense/typesense-backfill.service';
import { TermGroup } from '../terms/entities/term-group.entity';
import { TermConceptLexiconService } from './term-concept-lexicon.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Tag,
      Category,
      Brand,
      Vendor,
      AttributeValue,
      SpecificationValue,
      Product,
      ProductAttributeValue,
      ProductSpecificationValue,
      TermGroup,
    ]),
    forwardRef(() => ProductsModule),
  ],
  controllers: [SearchController, AdminTagsController, AdminSearchController],
  providers: [
    SearchService,
    SearchCacheService,
    TypesenseBackfillService,
    TagsService,
    TermConceptLexiconService,
  ],
  exports: [SearchCacheService, TagsService],
})
export class SearchModule {}
