import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { AnalyticsVisitorsService } from './analytics-visitors.service';
import { AdminClientDevicesService } from './admin-client-devices.service';
import { AnalyticsVisitor } from './entities/analytics-visitor.entity';
import { AnalyticsSession } from './entities/analytics-session.entity';
import { AnalyticsEvent } from './entities/analytics-event.entity';
import { AdminClientDevice } from './entities/admin-client-device.entity';
import { User } from '../users/entities/user.entity';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AnalyticsVisitor,
      AnalyticsSession,
      AnalyticsEvent,
      AdminClientDevice,
      User,
    ]),
    SettingsModule,
  ],
  controllers: [AnalyticsController],
  providers: [
    AnalyticsService,
    AnalyticsVisitorsService,
    AdminClientDevicesService,
  ],
})
export class AnalyticsModule {}
