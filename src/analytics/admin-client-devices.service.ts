import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AdminClientDevice } from './entities/admin-client-device.entity';
import { AnalyticsVisitor } from './entities/analytics-visitor.entity';
import { RegisterAdminClientDto } from './dto/register-admin-client.dto';

@Injectable()
export class AdminClientDevicesService {
  private cachedKeys: Set<string> | null = null;
  private cacheExpiresAt = 0;

  constructor(
    @InjectRepository(AdminClientDevice)
    private readonly devicesRepo: Repository<AdminClientDevice>,
    @InjectRepository(AnalyticsVisitor)
    private readonly visitorsRepo: Repository<AnalyticsVisitor>,
  ) {}

  async register(adminUserId: number, dto: RegisterAdminClientDto) {
    const browserKey = dto.browserKey.trim();
    const now = new Date();
    const source = (dto.source || 'admin_fe').slice(0, 32);
    const userAgent = dto.userAgent?.slice(0, 512) || null;

    let device = await this.devicesRepo.findOne({
      where: { browser_key: browserKey },
    });

    if (!device) {
      device = this.devicesRepo.create({
        browser_key: browserKey,
        admin_user_id: adminUserId,
        source,
        user_agent: userAgent,
        first_seen_at: now,
        last_seen_at: now,
      });
    } else {
      device.admin_user_id = adminUserId;
      device.source = source;
      if (userAgent) device.user_agent = userAgent;
      device.last_seen_at = now;
    }

    await this.devicesRepo.save(device);
    this.invalidateCache();

    // Remove any first-party visitor journeys already stored for this device.
    const purged = await this.visitorsRepo.delete({ browser_key: browserKey });

    return {
      id: device.id,
      browserKey: device.browser_key,
      adminUserId: device.admin_user_id,
      source: device.source,
      purgedVisitors: purged.affected || 0,
    };
  }

  async isAdminBrowserKey(browserKey: string): Promise<boolean> {
    const keys = await this.getAdminBrowserKeys();
    return keys.has(browserKey);
  }

  async getAdminBrowserKeys(): Promise<Set<string>> {
    const now = Date.now();
    if (this.cachedKeys && now < this.cacheExpiresAt) {
      return this.cachedKeys;
    }

    const rows = await this.devicesRepo.find({
      select: { browser_key: true },
    });
    this.cachedKeys = new Set(rows.map((row) => row.browser_key));
    this.cacheExpiresAt = now + 30_000;
    return this.cachedKeys;
  }

  async listForAdmin(adminUserId?: number) {
    const where = adminUserId ? { admin_user_id: adminUserId } : {};
    const rows = await this.devicesRepo.find({
      where,
      order: { last_seen_at: 'DESC' },
    });
    return rows.map((row) => ({
      id: row.id,
      browserKey: row.browser_key,
      adminUserId: row.admin_user_id,
      source: row.source,
      userAgent: row.user_agent,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
    }));
  }

  async excludeVisitorIds(visitorIds: number[]): Promise<number[]> {
    if (!visitorIds.length) return [];
    const keys = await this.getAdminBrowserKeys();
    if (!keys.size) return visitorIds;

    const visitors = await this.visitorsRepo.find({
      where: { id: In(visitorIds) },
      select: { id: true, browser_key: true },
    });

    const allowed = new Set(
      visitors
        .filter((visitor) => !keys.has(visitor.browser_key))
        .map((visitor) => visitor.id),
    );
    return visitorIds.filter((id) => allowed.has(id));
  }

  private invalidateCache() {
    this.cachedKeys = null;
    this.cacheExpiresAt = 0;
  }
}
