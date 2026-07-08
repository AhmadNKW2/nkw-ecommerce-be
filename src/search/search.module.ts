import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SearchService } from './search.service';
import { TagsService } from './tags.service';
import { SearchController } from './search.controller';
import { AdminTagsController } from './admin-tags.controller';
import { Tag } from './entities/tag.entity';
import { Category } from '../categories/entities/category.entity';
import { Brand } from '../brands/entities/brand.entity';
import { Vendor } from '../vendors/entities/vendor.entity';
import { AttributeValue } from '../attributes/entities/attribute-value.entity';
import { SpecificationValue } from '../specifications/entities/specification-value.entity';
import { ProductsModule } from '../products/products.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Tag, Category, Brand, Vendor, AttributeValue, SpecificationValue]),
    forwardRef(() => ProductsModule),
  ],
  controllers: [SearchController, AdminTagsController],
  providers: [SearchService, TagsService],
  exports: [TagsService],
})
export class SearchModule {}
