import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminNotificationsModule } from '../admin-notifications/admin-notifications.module';
import { Partner } from './entities/partner.entity';
import { PartnersController } from './partners.controller';
import { PartnersPublicController } from './partners-public.controller';
import { PartnersService } from './partners.service';

@Module({
  imports: [TypeOrmModule.forFeature([Partner]), AdminNotificationsModule],
  controllers: [PartnersPublicController, PartnersController],
  providers: [PartnersService],
})
export class PartnersModule {}