import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TermsService } from './terms.service';
import { TermsController } from './terms.controller';
import { TermGroup } from './entities/term-group.entity';
import { Product } from '../products/entities/product.entity';
import { Category } from '../categories/entities/category.entity';
import { ProductCategory } from '../products/entities/product-category.entity';

@Module({
  imports: [TypeOrmModule.forFeature([TermGroup, Product, Category, ProductCategory])],
  controllers: [TermsController],
  providers: [TermsService],
  exports: [TermsService],
})
export class TermsModule {}
