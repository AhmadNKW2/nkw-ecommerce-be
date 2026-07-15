import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { AdminClientDevice } from './entities/admin-client-device.entity';
import { AnalyticsVisitor } from './entities/analytics-visitor.entity';
import { RegisterAdminClientDto } from './dto/register-admin-client.dto';

export type AdminDeviceLookup = {
  deviceId: number;
  adminUserId: number;
  deviceName: string | null;
  deviceType: string | null;
  source: string;
  userAgent: string | null;
};

@Injectable()
export class AdminClientDevicesService implements OnModuleInit {
  private cachedKeys: Set<string> | null = null;
  private cachedByKey: Map<string, number> | null = null;
  private cachedDevicesByKey: Map<string, AdminDeviceLookup> | null = null;
  private cacheExpiresAt = 0;
  private schemaReady = false;

  constructor(
    @InjectRepository(AdminClientDevice)
    private readonly devicesRepo: Repository<AdminClientDevice>,
    @InjectRepository(AnalyticsVisitor)
    private readonly visitorsRepo: Repository<AnalyticsVisitor>,
    private readonly dataSource: DataSource,
  ) {}

  async onModuleInit() {
    await this.ensureSchema();
  }

  private async ensureSchema() {
    if (this.schemaReady) return;
    try {
      await this.dataSource.query(`
        ALTER TABLE admin_client_devices
          ADD COLUMN IF NOT EXISTS device_name varchar(120)
      `);
      await this.dataSource.query(`
        ALTER TABLE admin_client_devices
          ADD COLUMN IF NOT EXISTS device_type varchar(32)
      `);
      this.schemaReady = true;
    } catch {
      this.schemaReady = true;
    }
  }

  static parseDeviceType(userAgent: string | null | undefined): string {
    if (!userAgent) return 'Unknown';
    const ua = userAgent.toLowerCase();
    if (
      /ipad|tablet|kindle|silk|playbook|(android(?!.*mobile))/.test(ua)
    ) {
      return 'Tablet';
    }
    if (
      /mobi|iphone|ipod|android.*mobile|windows phone|blackberry|opera mini|iemobile/.test(
        ua,
      )
    ) {
      return 'Mobile';
    }
    return 'Desktop';
  }

  /**
   * Mark an existing browser client id as belonging to an admin.
   * Same admin user may register many browser keys (devices / profiles).
   */
  async register(adminUserId: number, dto: RegisterAdminClientDto) {
    await this.ensureSchema();
    const browserKey = dto.browserKey?.trim();
    if (!browserKey) {
      throw new BadRequestException('browserKey (client id) is required');
    }

    const now = new Date();
    const source = (dto.source || 'admin_fe').slice(0, 32);
    const userAgent = dto.userAgent?.slice(0, 512) || null;
    const deviceType = AdminClientDevicesService.parseDeviceType(userAgent);

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
        device_type: deviceType,
        device_name: null,
        first_seen_at: now,
        last_seen_at: now,
      });
    } else {
      device.admin_user_id = adminUserId;
      device.source = source;
      if (userAgent) {
        device.user_agent = userAgent;
        device.device_type = deviceType;
      }
      device.last_seen_at = now;
    }

    await this.devicesRepo.save(device);
    this.invalidateCache();

    let visitor = await this.visitorsRepo.findOne({
      where: { browser_key: browserKey },
    });
    if (!visitor) {
      visitor = await this.visitorsRepo.save(
        this.visitorsRepo.create({
          browser_key: browserKey,
          user_id: adminUserId,
          user_agent: userAgent,
          last_path: source === 'admin_fe' ? '/admin-dashboard' : null,
          event_count: 0,
          session_count: 0,
          first_seen_at: now,
          last_seen_at: now,
        }),
      );
    } else {
      visitor.user_id = visitor.user_id ?? adminUserId;
      if (userAgent) visitor.user_agent = userAgent;
      if (now > visitor.last_seen_at) visitor.last_seen_at = now;
      await this.visitorsRepo.save(visitor);
    }

    return {
      id: device.id,
      browserKey: device.browser_key,
      adminUserId: device.admin_user_id,
      source: device.source,
      deviceName: device.device_name,
      deviceType: device.device_type,
      reused,
      visitorId: visitor.id,
      purgedVisitors: 0,
    };
  }

  async renameDevice(deviceId: number, deviceName: string) {
    await this.ensureSchema();
    const name = deviceName.trim().slice(0, 120);
    if (!name) {
      throw new BadRequestException('deviceName is required');
    }

    const device = await this.devicesRepo.findOne({ where: { id: deviceId } });
    if (!device) {
      throw new NotFoundException(`Admin device #${deviceId} not found`);
    }

    device.device_name = name;
    await this.devicesRepo.save(device);
    this.invalidateCache();

    return {
      id: device.id,
      browserKey: device.browser_key,
      deviceName: device.device_name,
      deviceType: device.device_type,
      source: device.source,
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

  async getAdminUserIdByBrowserKey(): Promise<Map<string, number>> {
    await this.ensureCache();
    return this.cachedByKey!;
  }

  async getDevicesByBrowserKeys(
    browserKeys: string[],
  ): Promise<Map<string, AdminDeviceLookup>> {
    await this.ensureCache();
    const result = new Map<string, AdminDeviceLookup>();
    for (const key of browserKeys) {
      const row = this.cachedDevicesByKey?.get(key);
      if (row) result.set(key, row);
    }
    return result;
  }

  async listForAdmin(adminUserId?: number) {
    await this.ensureSchema();
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
      deviceName: row.device_name,
      deviceType: row.device_type,
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
    if (
      this.cachedKeys &&
      this.cachedByKey &&
      this.cachedDevicesByKey &&
      now < this.cacheExpiresAt
    ) {
      return;
    }

    await this.ensureSchema();
    const rows = await this.devicesRepo.find();
    this.cachedKeys = new Set(rows.map((row) => row.browser_key));
    this.cachedByKey = new Map(
      rows.map((row) => [row.browser_key, row.admin_user_id]),
    );
    this.cachedDevicesByKey = new Map(
      rows.map((row) => [
        row.browser_key,
        {
          deviceId: row.id,
          adminUserId: row.admin_user_id,
          deviceName: row.device_name,
          deviceType:
            row.device_type ||
            AdminClientDevicesService.parseDeviceType(row.user_agent),
          source: row.source,
          userAgent: row.user_agent,
        },
      ]),
    );
    this.cacheExpiresAt = now + 30_000;
  }

  private invalidateCache() {
    this.cachedKeys = null;
    this.cachedByKey = null;
    this.cachedDevicesByKey = null;
    this.cacheExpiresAt = 0;
  }
}
