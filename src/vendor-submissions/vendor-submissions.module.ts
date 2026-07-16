import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminNotificationsModule } from '../admin-notifications/admin-notifications.module';
import { AttributesModule } from '../attributes/attributes.module';
import { Brand } from '../brands/entities/brand.entity';
import { BrandsModule } from '../brands/brands.module';
import { CategoriesModule } from '../categories/categories.module';
import { ProductsModule } from '../products/products.module';
import { SpecificationsModule } from '../specifications/specifications.module';
import { CatalogRequestsController } from './catalog-requests.controller';
import { CatalogRequestsService } from './catalog-requests.service';
import { CatalogRequest } from './entities/catalog-request.entity';
import { VendorProductSubmissionMedia } from './entities/vendor-product-submission-media.entity';
import { VendorProductSubmission } from './entities/vendor-product-submission.entity';
import { VendorSubmissionAiService } from './vendor-submission-ai.service';
import { VendorSubmissionsController } from './vendor-submissions.controller';
import { VendorSubmissionsService } from './vendor-submissions.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      VendorProductSubmission,
      VendorProductSubmissionMedia,
      CatalogRequest,
      Brand,
    ]),
    ProductsModule,
    CategoriesModule,
    BrandsModule,
    SpecificationsModule,
    AttributesModule,
    AdminNotificationsModule,
  ],
  controllers: [VendorSubmissionsController, CatalogRequestsController],
  providers: [
    VendorSubmissionsService,
    CatalogRequestsService,
    VendorSubmissionAiService,
  ],
  exports: [VendorSubmissionsService, CatalogRequestsService],
})
export class VendorSubmissionsModule {}
