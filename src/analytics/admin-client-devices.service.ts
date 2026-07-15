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
import { parseDeviceInfo } from './device-info';

export type AdminDeviceLookup = {
  deviceId: number;
  adminUserId: number;
  deviceName: string | null;
  deviceType: string | null;
  deviceModel: string | null;
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
      await this.dataSource.query(`
        ALTER TABLE admin_client_devices
          ADD COLUMN IF NOT EXISTS device_model varchar(120)
      `);

      // Allow many admins per client id (and many clients per admin).
      // Drop legacy unique-on-browser_key-only indexes/constraints.
      await this.dataSource.query(`
        DO $$
        DECLARE r RECORD;
        BEGIN
          FOR r IN
            SELECT c.conname
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            WHERE t.relname = 'admin_client_devices'
              AND c.contype = 'u'
              AND pg_get_constraintdef(c.oid) ILIKE '%browser_key%'
              AND pg_get_constraintdef(c.oid) NOT ILIKE '%admin_user_id%'
          LOOP
            EXECUTE format('ALTER TABLE admin_client_devices DROP CONSTRAINT IF EXISTS %I', r.conname);
          END LOOP;

          FOR r IN
            SELECT i.relname AS idx
            FROM pg_class t
            JOIN pg_index ix ON t.oid = ix.indrelid
            JOIN pg_class i ON i.oid = ix.indexrelid
            WHERE t.relname = 'admin_client_devices'
              AND ix.indisunique
              AND NOT ix.indisprimary
              AND array_length(ix.indkey, 1) = 1
              AND EXISTS (
                SELECT 1
                FROM pg_attribute a
                WHERE a.attrelid = t.oid
                  AND a.attnum = ix.indkey[0]
                  AND a.attname = 'browser_key'
              )
          LOOP
            EXECUTE format('DROP INDEX IF EXISTS %I', r.idx);
          END LOOP;
        END $$;
      `);

      await this.dataSource.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_client_devices_browser_admin
          ON admin_client_devices (browser_key, admin_user_id)
      `);
      await this.dataSource.query(`
        CREATE INDEX IF NOT EXISTS idx_admin_client_devices_browser_key
          ON admin_client_devices (browser_key)
      `);

      this.schemaReady = true;
    } catch {
      this.schemaReady = true;
    }
  }

  static parseDeviceType(userAgent: string | null | undefined): string {
    return parseDeviceInfo(userAgent).type;
  }

  /**
   * Link a browser client id to the current admin.
   * Same admin → many clients; same client → many admins (separate rows).
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
    const parsed = parseDeviceInfo(userAgent, dto.deviceModel);
    const deviceType = parsed.type;
    const deviceModel = parsed.model;

    let device = await this.devicesRepo.findOne({
      where: { browser_key: browserKey, admin_user_id: adminUserId },
    });

    const reused = Boolean(device);

    // Device name / type / model belong to the client id — share across all admins.
    const siblings = await this.devicesRepo.find({
      where: { browser_key: browserKey },
      order: { id: 'ASC' },
    });
    const sharedName =
      siblings.find((row) => row.device_name?.trim())?.device_name ?? null;
    const sharedType =
      siblings.find((row) => row.device_type && row.device_type !== 'Unknown')
        ?.device_type ?? null;
    const sharedModel =
      siblings.find((row) => row.device_model?.trim())?.device_model ?? null;

    if (!device) {
      device = this.devicesRepo.create({
        browser_key: browserKey,
        admin_user_id: adminUserId,
        source,
        user_agent: userAgent,
        device_type: sharedType || deviceType,
        device_model:
          (sharedType || deviceType) === 'Desktop'
            ? null
            : sharedModel || deviceModel,
        device_name: sharedName,
        first_seen_at: now,
        last_seen_at: now,
      });
    } else {
      device.source = source;
      // Do not flip Desktop ↔ Mobile on the same client id (e.g. Chrome DevTools
      // device mode). Keep a stable fingerprint once we know it.
      const previousType = device.device_type || sharedType;
      const typeConflict =
        previousType &&
        previousType !== 'Unknown' &&
        deviceType !== 'Unknown' &&
        previousType !== deviceType;

      if (userAgent && !typeConflict) {
        device.user_agent = userAgent;
        device.device_type = deviceType;
      } else if (!device.device_type && deviceType) {
        device.device_type = deviceType;
      }

      if (!typeConflict) {
        if (deviceModel) {
          device.device_model = deviceType === 'Desktop' ? null : deviceModel;
        } else if (userAgent && !device.device_model && deviceType !== 'Desktop') {
          device.device_model = parseDeviceInfo(userAgent).model;
        }
      }
      if ((device.device_type || deviceType) === 'Desktop') {
        device.device_model = null;
      }
      if (!device.device_name && sharedName) {
        device.device_name = sharedName;
      }
      device.last_seen_at = now;
    }

    await this.devicesRepo.save(device);
    await this.syncClientDeviceFields(browserKey, {
      deviceName: device.device_name,
      deviceType: device.device_type,
      deviceModel: device.device_model,
      userAgent: device.user_agent,
    });
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
          device_type: deviceType,
          device_model: deviceModel,
          last_path: source === 'admin_fe' ? '/admin-dashboard' : null,
          event_count: 0,
          session_count: 0,
          first_seen_at: now,
          last_seen_at: now,
        }),
      );
    } else {
      // Do not bump visitor.last_seen_at here — that is analytics activity only.
      // Otherwise opening the admin panel makes "Last seen" newer than any session.
      visitor.user_id = visitor.user_id ?? adminUserId;
      if (userAgent) visitor.user_agent = userAgent;
      if (deviceType) visitor.device_type = deviceType;
      if (deviceModel) visitor.device_model = deviceModel;
      await this.visitorsRepo.save(visitor);
    }

    return {
      id: device.id,
      browserKey: device.browser_key,
      adminUserId: device.admin_user_id,
      source: device.source,
      deviceName: device.device_name,
      deviceType: device.device_type,
      deviceModel: device.device_model,
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

    // Name is per client id — update every admin row for this browser key.
    await this.devicesRepo.update(
      { browser_key: device.browser_key },
      { device_name: name },
    );
    this.invalidateCache();

    return {
      id: device.id,
      browserKey: device.browser_key,
      deviceName: name,
      deviceType: device.device_type,
      deviceModel: device.device_model,
      source: device.source,
    };
  }

  /**
   * Keep device name / type / model identical for every admin linked to a client id.
   */
  private async syncClientDeviceFields(
    browserKey: string,
    fields: {
      deviceName?: string | null;
      deviceType?: string | null;
      deviceModel?: string | null;
      userAgent?: string | null;
    },
  ) {
    const patch: Partial<AdminClientDevice> = {};
    if (fields.deviceName !== undefined) patch.device_name = fields.deviceName;
    if (fields.deviceType !== undefined) patch.device_type = fields.deviceType;
    if (fields.deviceModel !== undefined) {
      patch.device_model =
        fields.deviceType === 'Desktop' ? null : fields.deviceModel;
    }
    if (fields.userAgent !== undefined) patch.user_agent = fields.userAgent;
    if (!Object.keys(patch).length) return;
    await this.devicesRepo.update({ browser_key: browserKey }, patch);
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

  /** All device registrations (one row per admin×client pair). */
  async listAllDevices(): Promise<
    Array<{
      id: number;
      browserKey: string;
      adminUserId: number;
      source: string;
      deviceName: string | null;
      deviceType: string | null;
      deviceModel: string | null;
      userAgent: string | null;
      firstSeenAt: Date;
      lastSeenAt: Date;
    }>
  > {
    await this.ensureSchema();
    const rows = await this.devicesRepo.find({
      order: { id: 'DESC' },
    });
    return rows.map((row) => {
      const parsed = parseDeviceInfo(row.user_agent, row.device_model);
      return {
        id: row.id,
        browserKey: row.browser_key,
        adminUserId: row.admin_user_id,
        source: row.source,
        deviceName: row.device_name,
        deviceType: row.device_type || parsed.type,
        deviceModel: row.device_model || parsed.model,
        userAgent: row.user_agent,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
      };
    });
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
      deviceModel: row.device_model,
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

  /** Remove admin-device mark for a browser key (used when deleting a client). */
  async unregisterBrowserKey(browserKey: string): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.devicesRepo.delete({ browser_key: browserKey });
    this.invalidateCache();
    return (result.affected ?? 0) > 0;
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
    const rows = await this.devicesRepo.find({ order: { id: 'ASC' } });
    this.cachedKeys = new Set(rows.map((row) => row.browser_key));
    // One admin id per key for legacy lookup (latest registration wins for badge/detail).
    this.cachedByKey = new Map();
    this.cachedDevicesByKey = new Map();
    for (const row of rows) {
      this.cachedByKey.set(row.browser_key, row.admin_user_id);
      const parsed = parseDeviceInfo(row.user_agent, row.device_model);
      this.cachedDevicesByKey.set(row.browser_key, {
        deviceId: row.id,
        adminUserId: row.admin_user_id,
        deviceName: row.device_name,
        deviceType: row.device_type || parsed.type,
        deviceModel: row.device_model || parsed.model,
        source: row.source,
        userAgent: row.user_agent,
      });
    }
    this.cacheExpiresAt = now + 30_000;
  }

  private invalidateCache() {
    this.cachedKeys = null;
    this.cachedByKey = null;
    this.cachedDevicesByKey = null;
    this.cacheExpiresAt = 0;
  }
}
