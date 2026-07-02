import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { TypesenseService } from '../typesense/typesense.service';

@Injectable()
export class HealthService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly typesenseService: TypesenseService,
  ) {}

  async check() {
    const timestamp = new Date().toISOString();
    const uptime = process.uptime();

    const start = Date.now();
    try {
      // Lightweight query to ensure the DB compute is awake (Neon Scale-to-Zero).
      await this.dataSource.query('SELECT 1');
      const latencyMs = Date.now() - start;

      return {
        status: 'ok',
        timestamp,
        uptime,
        db: {
          status: 'ok',
          latency_ms: latencyMs,
        },
      };
    } catch (error) {
      const latencyMs = Date.now() - start;
      throw new ServiceUnavailableException({
        status: 'unavailable',
        timestamp,
        uptime,
        db: {
          status: 'down',
          latency_ms: latencyMs,
        },
      });
    }
  }

  async checkTypesense() {
    const result = await this.typesenseService.healthCheck();

    if (result.status === 'down') {
      throw new ServiceUnavailableException({
        status: 'unavailable',
        timestamp: new Date().toISOString(),
        typesense: result,
      });
    }

    return {
      status: result.status === 'disabled' ? 'ok' : 'ok',
      timestamp: new Date().toISOString(),
      typesense: result,
    };
  }
}
