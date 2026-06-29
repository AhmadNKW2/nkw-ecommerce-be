import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SearchService } from './search.service';
import { TagsService } from './tags.service';
import { SearchController } from './search.controller';
import { AdminTagsController } from './admin-tags.controller';
import { Tag } from './entities/tag.entity';
import { ProductsModule } from '../products/products.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Tag]),
    forwardRef(() => ProductsModule),
  ],
  controllers: [SearchController, AdminTagsController],
  providers: [SearchService, TagsService],
  exports: [TagsService],
})
export class SearchModule {}
