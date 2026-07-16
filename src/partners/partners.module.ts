import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Partner } from './entities/partner.entity';
import { PartnersController } from './partners.controller';
import { PartnersPublicController } from './partners-public.controller';
import { PartnersService } from './partners.service';

@Module({
  imports: [TypeOrmModule.forFeature([Partner])],
  controllers: [PartnersPublicController, PartnersController],
  providers: [PartnersService],
})
export class PartnersModule {}