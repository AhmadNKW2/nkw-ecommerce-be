import { Controller, Get } from '@nestjs/common';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  async getHealth() {
    return this.healthService.check();
  }

  @Get('typesense')
  async getTypesenseHealth() {
    return this.healthService.checkTypesense();
  }
}
