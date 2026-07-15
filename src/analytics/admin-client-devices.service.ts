import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AdminClientDevice } from './entities/admin-client-device.entity';
import { AnalyticsVisitor } from './entities/analytics-visitor.entity';
import { RegisterAdminClientDto } from './dto/register-admin-client.dto';

@Injectable()
export class AdminClientDevicesService {
  private cachedKeys: Set<string> | null = null;
  private cachedByKey: Map<string, number> | null = null;
  private cacheExpiresAt = 0;

  constructor(
    @InjectRepository(AdminClientDevice)
    private readonly devicesRepo: Repository<AdminClientDevice>,
    @InjectRepository(AnalyticsVisitor)
    private readonly visitorsRepo: Repository<AnalyticsVisitor>,
  ) {}

  /**
   * Mark an existing browser client id as belonging to an admin.
   * Same admin user may register many browser keys (devices / profiles).
   * Never generates a new client id — the browser must send its stored one.
   */
  async register(adminUserId: number, dto: RegisterAdminClientDto) {
    const browserKey = dto.browserKey?.trim();
    if (!browserKey) {
      throw new BadRequestException('browserKey (client id) is required');
    }

    const now = new Date();
    const source = (dto.source || 'admin_fe').slice(0, 32);
    const userAgent = dto.userAgent?.slice(0, 512) || null;

    let device = await this.devicesRepo.findOne({
      where: { browser_key: browserKey },
    });

    const reused = Boolean(device);

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

    return {
      id: device.id,
      browserKey: device.browser_key,
      adminUserId: device.admin_user_id,
      source: device.source,
      reused,
      purgedVisitors: 0,
    };
  }

  async isAdminBrowserKey(browserKey: string): Promise<boolean> {
    const keys = await this.getAdminBrowserKeys();
    return keys.has(browserKey);
  }

  async getAdminBrowserKeys(): Promise<Set<string>> {
    await this.ensureCache();
    return this.cachedKeys!;
  }

  /** Map browser_key → admin_user_id for visitor enrichment. */
  async getAdminUserIdByBrowserKey(): Promise<Map<string, number>> {
    await this.ensureCache();
    return this.cachedByKey!;
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

  async listMine(adminUserId: number) {
    return this.listForAdmin(adminUserId);
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

  private async ensureCache() {
    const now = Date.now();
    if (this.cachedKeys && this.cachedByKey && now < this.cacheExpiresAt) {
      return;
    }

    const rows = await this.devicesRepo.find({
      select: { browser_key: true, admin_user_id: true },
    });
    this.cachedKeys = new Set(rows.map((row) => row.browser_key));
    this.cachedByKey = new Map(
      rows.map((row) => [row.browser_key, row.admin_user_id]),
    );
    this.cacheExpiresAt = now + 30_000;
  }

  private invalidateCache() {
    this.cachedKeys = null;
    this.cachedByKey = null;
    this.cacheExpiresAt = 0;
  }
}
