import { Controller, Sse, UseGuards, MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles, UserRole } from '../common/decorators/roles.decorator';
import { AdminNotificationsService } from './admin-notifications.service';

@Controller('admin-notifications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminNotificationsController {
  constructor(
    private readonly adminNotificationsService: AdminNotificationsService,
  ) {}

  @Sse('stream')
  stream(): Observable<MessageEvent> {
    return this.adminNotificationsService.stream();
  }
}
