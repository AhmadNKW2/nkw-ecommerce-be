import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { AnalyticsVisitor } from './entities/analytics-visitor.entity';
import { AnalyticsSession } from './entities/analytics-session.entity';
import { AnalyticsEvent } from './entities/analytics-event.entity';
import { CollectAnalyticsDto } from './dto/collect-analytics.dto';
import { ListVisitorsDto } from './dto/list-visitors.dto';
import { AdminClientDevicesService } from './admin-client-devices.service';
import { parseDeviceInfo } from './device-info';
import { User } from '../users/entities/user.entity';

type AdminVisitorInfo = {
  userId: number;
  email: string;
  name: string;
  deviceId: number | null;
  deviceName: string | null;
  deviceType: string | null;
  deviceModel: string | null;
  source: string | null;
};

@Injectable()
export class AnalyticsVisitorsService implements OnModuleInit {
  private schemaReady = false;

  constructor(
    @InjectRepository(AnalyticsVisitor)
    private readonly visitorsRepo: Repository<AnalyticsVisitor>,
    @InjectRepository(AnalyticsSession)
    private readonly sessionsRepo: Repository<AnalyticsSession>,
    @InjectRepository(AnalyticsEvent)
    private readonly eventsRepo: Repository<AnalyticsEvent>,
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    private readonly adminClientDevicesService: AdminClientDevicesService,
    private readonly dataSource: DataSource,
  ) {}

  async onModuleInit() {
    await this.ensureSchema();
  }

  private async ensureSchema() {
    if (this.schemaReady) return;
    try {
      await this.dataSource.query(`
        ALTER TABLE analytics_visitors
          ADD COLUMN IF NOT EXISTS device_type varchar(32)
      `);
      await this.dataSource.query(`
        ALTER TABLE analytics_visitors
          ADD COLUMN IF NOT EXISTS device_model varchar(120)
      `);
      this.schemaReady = true;
    } catch {
      this.schemaReady = true;
    }
  }

  async collect(dto: CollectAnalyticsDto) {
    await this.ensureSchema();
    // Admin devices are collected too; Visitors vs Admins tabs filter visibility.
    const now = new Date();
    const events = dto.events
      .map((event) => ({
        name: event.name.trim().slice(0, 160),
        path: (event.path || '').trim().slice(0, 1024) || null,
        properties: event.properties || null,
        occurredAt: event.occurredAt ? new Date(event.occurredAt) : now,
      }))
      .filter((event) => event.name.length > 0);

    if (!events.length) {
      return { accepted: 0 };
    }

    const userAgent = dto.userAgent?.slice(0, 512) || null;
    const parsed = parseDeviceInfo(userAgent, dto.deviceModel);

    let visitor = await this.visitorsRepo.findOne({
      where: { browser_key: dto.browserKey },
    });

    const latestPath =
      [...events].reverse().find((event) => event.path)?.path || null;

    if (!visitor) {
      visitor = this.visitorsRepo.create({
        browser_key: dto.browserKey,
        user_id: dto.userId ?? null,
        user_agent: userAgent,
        device_type: parsed.type,
        device_model: parsed.model,
        last_path: latestPath,
        event_count: 0,
        session_count: 0,
        first_seen_at: events[0].occurredAt,
        last_seen_at: events[events.length - 1].occurredAt,
      });
      visitor = await this.visitorsRepo.save(visitor);
    } else {
      visitor.user_id = dto.userId ?? visitor.user_id;
      if (userAgent) {
        visitor.user_agent = userAgent;
        visitor.device_type = parsed.type;
      }
      if (parsed.model) {
        visitor.device_model = parsed.model;
      } else if (userAgent && !visitor.device_model) {
        visitor.device_model = parseDeviceInfo(userAgent).model;
      }
      if (latestPath) {
        visitor.last_path = latestPath;
      }
      if (events[0].occurredAt < visitor.first_seen_at) {
        visitor.first_seen_at = events[0].occurredAt;
      }
      if (events[events.length - 1].occurredAt > visitor.last_seen_at) {
        visitor.last_seen_at = events[events.length - 1].occurredAt;
      }
      await this.visitorsRepo.save(visitor);
    }

    let session = await this.sessionsRepo.findOne({
      where: {
        visitor_id: visitor.id,
        session_key: dto.sessionKey,
      },
    });

    const firstPath = events.find((event) => event.path)?.path || null;
    const lastPath = latestPath;

    if (!session) {
      session = this.sessionsRepo.create({
        visitor_id: visitor.id,
        session_key: dto.sessionKey,
        landing_path: firstPath,
        exit_path: lastPath,
        event_count: 0,
        page_view_count: 0,
        duration_seconds: 0,
        started_at: events[0].occurredAt,
        last_seen_at: events[events.length - 1].occurredAt,
      });
      session = await this.sessionsRepo.save(session);
      visitor.session_count += 1;
    } else {
      if (!session.landing_path && firstPath) {
        session.landing_path = firstPath;
      }
      if (lastPath) {
        session.exit_path = lastPath;
      }
      if (events[events.length - 1].occurredAt > session.last_seen_at) {
        session.last_seen_at = events[events.length - 1].occurredAt;
      }
      session.duration_seconds = Math.max(
        0,
        Math.round(
          (session.last_seen_at.getTime() - session.started_at.getTime()) /
            1000,
        ),
      );
    }

    const pageViews = events.filter((event) =>
      /page\s*viewed|page_view|pageview/i.test(event.name),
    ).length;

    const eventEntities = events.map((event) =>
      this.eventsRepo.create({
        visitor_id: visitor.id,
        session_id: session.id,
        event_name: event.name,
        path: event.path,
        properties: event.properties,
        occurred_at: event.occurredAt,
      }),
    );

    await this.eventsRepo.save(eventEntities);

    session.event_count += events.length;
    session.page_view_count += pageViews;
    session.duration_seconds = Math.max(
      0,
      Math.round(
        (session.last_seen_at.getTime() - session.started_at.getTime()) / 1000,
      ),
    );
    await this.sessionsRepo.save(session);

    visitor.event_count += events.length;
    if (session.last_seen_at > visitor.last_seen_at) {
      visitor.last_seen_at = session.last_seen_at;
    }
    await this.visitorsRepo.save(visitor);

    return { accepted: events.length, visitorId: visitor.id, sessionId: session.id };
  }

  private applyVisitorSort(
    qb: ReturnType<Repository<AnalyticsVisitor>['createQueryBuilder']>,
    query: ListVisitorsDto,
    options?: { withAdminJoins?: boolean },
  ) {
    const dir = query.sortOrder === 'asc' ? 'ASC' : 'DESC';
    const sortBy = query.sortBy || 'lastSeen';
    const nulls = dir === 'ASC' ? 'NULLS FIRST' : 'NULLS LAST';
    const allowAdminSort = options?.withAdminJoins === true;

    switch (sortBy) {
      case 'lastPath':
        qb.orderBy('visitor.last_path', dir, nulls);
        break;
      case 'sessions':
        qb.orderBy('visitor.session_count', dir, nulls);
        break;
      case 'events':
        qb.orderBy('visitor.event_count', dir, nulls);
        break;
      case 'duration':
        qb.orderBy(
          `(SELECT COALESCE(SUM(s.duration_seconds), 0) FROM analytics_sessions s WHERE s.visitor_id = visitor.id)`,
          dir,
        );
        break;
      case 'deviceName':
        if (allowAdminSort) {
          qb.orderBy(
            `(SELECT d.device_name FROM admin_client_devices d WHERE d.browser_key = visitor.browser_key ORDER BY d.id DESC LIMIT 1)`,
            dir,
            nulls,
          );
        } else {
          qb.orderBy(
            `(SELECT MAX(s.last_seen_at) FROM analytics_sessions s WHERE s.visitor_id = visitor.id)`,
            dir,
            nulls,
          ).addOrderBy('visitor.last_seen_at', dir);
        }
        break;
      case 'admin':
        if (allowAdminSort) {
          qb.orderBy(
            `(SELECT LOWER(COALESCE(u."firstName", '') || ' ' || COALESCE(u."lastName", '') || ' ' || COALESCE(u.email, ''))
              FROM admin_client_devices d
              INNER JOIN users u ON u.id = d.admin_user_id
              WHERE d.browser_key = visitor.browser_key
              ORDER BY d.id DESC LIMIT 1)`,
            dir,
            nulls,
          );
        } else {
          qb.orderBy(
            `(SELECT MAX(s.last_seen_at) FROM analytics_sessions s WHERE s.visitor_id = visitor.id)`,
            dir,
            nulls,
          ).addOrderBy('visitor.last_seen_at', dir);
        }
        break;
      case 'firstSeen':
        qb.orderBy('visitor.first_seen_at', dir, nulls);
        break;
      case 'lastSeen':
      default:
        qb.orderBy(
          `(SELECT MAX(s.last_seen_at) FROM analytics_sessions s WHERE s.visitor_id = visitor.id)`,
          dir,
          nulls,
        ).addOrderBy('visitor.last_seen_at', dir);
        break;
    }

    qb.addOrderBy('visitor.id', 'DESC');
  }

  async listVisitors(query: ListVisitorsDto) {
    const audience = query.audience === 'admins' ? 'admins' : 'visitors';
    if (audience === 'admins') {
      return this.listAdminAudience(query);
    }

    const page = query.page || 1;
    const limit = query.limit || 20;
    const adminKeyToUserId =
      await this.adminClientDevicesService.getAdminUserIdByBrowserKey();
    const adminKeys = [...adminKeyToUserId.keys()];

    const qb = this.visitorsRepo
      .createQueryBuilder('visitor')
      .skip((page - 1) * limit)
      .take(limit);

    this.applyVisitorSort(qb, query);

    if (adminKeys.length) {
      qb.andWhere('visitor.browser_key NOT IN (:...adminKeys)', { adminKeys });
    }

    if (query.startDate && query.endDate) {
      const start = new Date(`${query.startDate}T00:00:00.000Z`);
      const end = new Date(`${query.endDate}T23:59:59.999Z`);
      qb.andWhere('visitor.last_seen_at BETWEEN :start AND :end', {
        start,
        end,
      });
    }

    if (query.search?.trim()) {
      const term = query.search.trim();
      if (/^\d+$/.test(term)) {
        qb.andWhere('visitor.id = :id', { id: Number(term) });
      } else {
        qb.andWhere('visitor.last_path ILIKE :path', { path: `%${term}%` });
      }
    }

    const [rows, total] = await qb.getManyAndCount();
    return this.mapVisitorListRows(rows, total, page, limit, 'visitors', new Map());
  }

  /**
   * Admins tab: one row per admin×client registration.
   * Same admin can appear on many Client #s; same Client # can appear for many admins.
   */
  private async listAdminAudience(query: ListVisitorsDto) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const devices = await this.adminClientDevicesService.listAllDevices();

    if (!devices.length) {
      return {
        data: [],
        meta: { total: 0, page, limit, totalPages: 1, audience: 'admins' as const },
      };
    }

    const uniqueKeys = [...new Set(devices.map((device) => device.browserKey))];

    // Ensure every admin-linked browser has a visitor row (Client #).
    for (const browserKey of uniqueKeys) {
      const exists = await this.visitorsRepo.exists({
        where: { browser_key: browserKey },
      });
      if (exists) continue;
      const device = devices.find((row) => row.browserKey === browserKey);
      const now = new Date();
      await this.visitorsRepo.save(
        this.visitorsRepo.create({
          browser_key: browserKey,
          user_id: device?.adminUserId ?? null,
          user_agent: device?.userAgent ?? null,
          device_type: device?.deviceType ?? null,
          device_model: device?.deviceModel ?? null,
          last_path: '/admin-dashboard',
          event_count: 0,
          session_count: 0,
          first_seen_at: now,
          last_seen_at: now,
        }),
      );
    }

    const visitors = await this.visitorsRepo.find({
      where: { browser_key: In(uniqueKeys) },
    });
    const visitorByKey = new Map(
      visitors.map((visitor) => [visitor.browser_key, visitor]),
    );

    const userIds = [...new Set(devices.map((device) => device.adminUserId))];
    const users = userIds.length
      ? await this.usersRepo.find({
          where: { id: In(userIds) },
          select: { id: true, email: true, firstName: true, lastName: true },
        })
      : [];
    const usersById = new Map(users.map((user) => [user.id, user]));

    // Device name / type / model are per client id — one shared value for all admin rows.
    const sharedDeviceByKey = new Map<
      string,
      {
        deviceName: string | null;
        deviceType: string | null;
        deviceModel: string | null;
      }
    >();
    for (const device of devices) {
      const cur = sharedDeviceByKey.get(device.browserKey) ?? {
        deviceName: null,
        deviceType: null,
        deviceModel: null,
      };
      sharedDeviceByKey.set(device.browserKey, {
        deviceName: cur.deviceName || device.deviceName,
        deviceType:
          cur.deviceType && cur.deviceType !== 'Unknown'
            ? cur.deviceType
            : device.deviceType || cur.deviceType,
        deviceModel: cur.deviceModel || device.deviceModel,
      });
    }

    type AdminPair = { visitor: AnalyticsVisitor; admin: AdminVisitorInfo };
    let pairs: AdminPair[] = [];
    for (const device of devices) {
      const visitor = visitorByKey.get(device.browserKey);
      if (!visitor) continue;
      const user = usersById.get(device.adminUserId);
      const shared = sharedDeviceByKey.get(device.browserKey);
      const deviceType =
        shared?.deviceType || visitor.device_type || null;
      const deviceModel =
        deviceType === 'Desktop'
          ? null
          : shared?.deviceModel || visitor.device_model || null;
      pairs.push({
        visitor,
        admin: {
          userId: device.adminUserId,
          email: user?.email || '',
          name: user
            ? `${user.firstName || ''} ${user.lastName || ''}`.trim() ||
              user.email
            : 'Admin',
          deviceId: device.id,
          deviceName: shared?.deviceName ?? null,
          deviceType,
          deviceModel,
          source: device.source,
        },
      });
    }

    const term = query.search?.trim();
    if (term) {
      if (/^\d+$/.test(term)) {
        const id = Number(term);
        pairs = pairs.filter(
          (pair) => pair.visitor.id === id || pair.admin.userId === id,
        );
      } else {
        const lower = term.toLowerCase();
        pairs = pairs.filter((pair) => {
          const hay = [
            pair.visitor.last_path,
            pair.admin.email,
            pair.admin.name,
            pair.admin.deviceName,
            pair.admin.deviceType,
            pair.admin.deviceModel,
            pair.admin.source,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return hay.includes(lower);
        });
      }
    }

    const visitorIds = [...new Set(pairs.map((pair) => pair.visitor.id))];
    const sessions =
      visitorIds.length === 0
        ? []
        : await this.sessionsRepo
            .createQueryBuilder('session')
            .where('session.visitor_id IN (:...visitorIds)', { visitorIds })
            .getMany();

    const durationByVisitor = new Map<number, number>();
    const activityLastSeenByVisitor = new Map<number, Date>();
    for (const session of sessions) {
      durationByVisitor.set(
        session.visitor_id,
        (durationByVisitor.get(session.visitor_id) || 0) +
          (session.duration_seconds || 0),
      );
      const prev = activityLastSeenByVisitor.get(session.visitor_id);
      if (!prev || session.last_seen_at > prev) {
        activityLastSeenByVisitor.set(session.visitor_id, session.last_seen_at);
      }
    }

    const dir = query.sortOrder === 'asc' ? 1 : -1;
    const sortBy = query.sortBy || 'lastSeen';

    const cmpText = (a: string | null | undefined, b: string | null | undefined) =>
      (a || '').localeCompare(b || '', undefined, { sensitivity: 'base' });
    const cmpNum = (a: number, b: number) => a - b;
    const cmpDate = (a: Date, b: Date) => a.getTime() - b.getTime();

    pairs.sort((left, right) => {
      let primary = 0;
      switch (sortBy) {
        case 'lastPath':
          primary = cmpText(left.visitor.last_path, right.visitor.last_path);
          break;
        case 'sessions':
          primary = cmpNum(left.visitor.session_count, right.visitor.session_count);
          break;
        case 'events':
          primary = cmpNum(left.visitor.event_count, right.visitor.event_count);
          break;
        case 'duration':
          primary = cmpNum(
            durationByVisitor.get(left.visitor.id) || 0,
            durationByVisitor.get(right.visitor.id) || 0,
          );
          break;
        case 'deviceName':
          primary = cmpText(left.admin.deviceName, right.admin.deviceName);
          break;
        case 'admin':
          primary = cmpText(
            left.admin.name || left.admin.email,
            right.admin.name || right.admin.email,
          );
          break;
        case 'firstSeen':
          primary = cmpDate(left.visitor.first_seen_at, right.visitor.first_seen_at);
          break;
        case 'lastSeen':
        default: {
          const leftSeen =
            activityLastSeenByVisitor.get(left.visitor.id) ??
            left.visitor.last_seen_at;
          const rightSeen =
            activityLastSeenByVisitor.get(right.visitor.id) ??
            right.visitor.last_seen_at;
          primary = cmpDate(leftSeen, rightSeen);
          break;
        }
      }
      if (primary !== 0) return primary * dir;
      // Stable tie-break: newer device registration first, then client id.
      if (left.admin.deviceId !== right.admin.deviceId) {
        return (right.admin.deviceId || 0) - (left.admin.deviceId || 0);
      }
      return right.visitor.id - left.visitor.id;
    });

    const total = pairs.length;
    const pagePairs = pairs.slice((page - 1) * limit, page * limit);

    return {
      data: pagePairs.map(({ visitor, admin }) => {
        const resolvedLastSeen =
          activityLastSeenByVisitor.get(visitor.id) ?? visitor.last_seen_at;
        const parsed = parseDeviceInfo(
          visitor.user_agent,
          visitor.device_model || admin.deviceModel,
        );
        const deviceType =
          admin.deviceType || visitor.device_type || parsed.type;
        const deviceModel =
          deviceType === 'Desktop'
            ? null
            : admin.deviceModel || visitor.device_model || parsed.model;
        return {
          id: visitor.id,
          rowKey: `d-${admin.deviceId}`,
          userId: visitor.user_id,
          lastPath: visitor.last_path,
          eventCount: visitor.event_count,
          sessionCount: visitor.session_count,
          totalDurationSeconds: durationByVisitor.get(visitor.id) || 0,
          firstSeenAt: visitor.first_seen_at,
          lastSeenAt: resolvedLastSeen,
          userAgent: visitor.user_agent,
          deviceType,
          deviceModel,
          deviceLabel: deviceModel ? `${deviceType} · ${deviceModel}` : deviceType,
          isAdmin: true,
          admin,
        };
      }),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        audience: 'admins' as const,
      },
    };
  }

  private async mapVisitorListRows(
    rows: AnalyticsVisitor[],
    total: number,
    page: number,
    limit: number,
    audience: 'visitors' | 'admins',
    adminInfoByBrowserKey: Map<string, AdminVisitorInfo>,
  ) {
    const visitorIds = rows.map((row) => row.id);
    const sessions =
      visitorIds.length === 0
        ? []
        : await this.sessionsRepo
            .createQueryBuilder('session')
            .where('session.visitor_id IN (:...visitorIds)', { visitorIds })
            .getMany();

    const durationByVisitor = new Map<number, number>();
    const activityLastSeenByVisitor = new Map<number, Date>();
    for (const session of sessions) {
      durationByVisitor.set(
        session.visitor_id,
        (durationByVisitor.get(session.visitor_id) || 0) +
          (session.duration_seconds || 0),
      );
      const prev = activityLastSeenByVisitor.get(session.visitor_id);
      if (!prev || session.last_seen_at > prev) {
        activityLastSeenByVisitor.set(session.visitor_id, session.last_seen_at);
      }
    }

    return {
      data: rows.map((visitor) => {
        const admin = adminInfoByBrowserKey.get(visitor.browser_key) || null;
        // Prefer real session activity over inflated visitor.last_seen_at
        // (e.g. from older admin-panel heartbeats).
        const resolvedLastSeen =
          activityLastSeenByVisitor.get(visitor.id) ?? visitor.last_seen_at;
        const parsed = parseDeviceInfo(
          visitor.user_agent,
          visitor.device_model || admin?.deviceModel,
        );
        const deviceType =
          audience === 'admins'
            ? admin?.deviceType || visitor.device_type || parsed.type
            : visitor.device_type || admin?.deviceType || parsed.type;
        const deviceModel =
          deviceType === 'Desktop'
            ? null
            : audience === 'admins'
              ? admin?.deviceModel || visitor.device_model || parsed.model
              : visitor.device_model || admin?.deviceModel || parsed.model;
        const deviceLabel = deviceModel
          ? `${deviceType} · ${deviceModel}`
          : deviceType;
        return {
          id: visitor.id,
          userId: visitor.user_id,
          lastPath: visitor.last_path,
          eventCount: visitor.event_count,
          sessionCount: visitor.session_count,
          totalDurationSeconds: durationByVisitor.get(visitor.id) || 0,
          firstSeenAt: visitor.first_seen_at,
          lastSeenAt: resolvedLastSeen,
          userAgent: visitor.user_agent,
          deviceType,
          deviceModel,
          deviceLabel,
          isAdmin: Boolean(admin) || audience === 'admins',
          admin,
        };
      }),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        audience,
      },
    };
  }

  async getVisitor(id: number) {
    const visitor = await this.visitorsRepo.findOne({ where: { id } });
    if (!visitor) {
      throw new NotFoundException(`Visitor #${id} not found`);
    }

    const adminKeyToUserId =
      await this.adminClientDevicesService.getAdminUserIdByBrowserKey();
    const adminInfoByBrowserKey = await this.resolveAdminInfoByBrowserKeys(
      [visitor.browser_key],
      adminKeyToUserId,
    );
    const admin = adminInfoByBrowserKey.get(visitor.browser_key) || null;

    const sessions = await this.sessionsRepo.find({
      where: { visitor_id: id },
      order: { started_at: 'DESC' },
    });

    const events = await this.eventsRepo.find({
      where: { visitor_id: id },
      order: { occurred_at: 'ASC' },
      take: 500,
    });

    const totalDurationSeconds = sessions.reduce(
      (sum, session) => sum + (session.duration_seconds || 0),
      0,
    );

    const activityLastSeen = sessions.reduce<Date | null>((max, session) => {
      if (!max || session.last_seen_at > max) return session.last_seen_at;
      return max;
    }, null);

    const parsed = parseDeviceInfo(
      visitor.user_agent,
      visitor.device_model || admin?.deviceModel,
    );

    return {
      id: visitor.id,
      userId: visitor.user_id,
      lastPath: visitor.last_path,
      eventCount: visitor.event_count,
      sessionCount: visitor.session_count,
      totalDurationSeconds,
      firstSeenAt: visitor.first_seen_at,
      lastSeenAt: activityLastSeen ?? visitor.last_seen_at,
      userAgent: visitor.user_agent,
      deviceType: admin?.deviceType || visitor.device_type || parsed.type,
      deviceModel: admin?.deviceModel || visitor.device_model || parsed.model,
      deviceLabel: parsed.label,
      isAdmin: Boolean(admin),
      admin,
      sessions: sessions.map((session) => ({
        id: session.id,
        landingPath: session.landing_path,
        exitPath: session.exit_path,
        eventCount: session.event_count,
        pageViewCount: session.page_view_count,
        durationSeconds: session.duration_seconds,
        startedAt: session.started_at,
        lastSeenAt: session.last_seen_at,
      })),
      events: events.map((event) => ({
        id: event.id,
        sessionId: event.session_id,
        name: event.event_name,
        path: event.path,
        properties: event.properties,
        occurredAt: event.occurred_at,
      })),
    };
  }

  async deleteVisitor(id: number) {
    const visitor = await this.visitorsRepo.findOne({ where: { id } });
    if (!visitor) {
      throw new NotFoundException(`Visitor #${id} not found`);
    }

    const browserKey = visitor.browser_key;

    await this.eventsRepo.delete({ visitor_id: id });
    await this.sessionsRepo.delete({ visitor_id: id });
    await this.visitorsRepo.delete({ id });
    // Unregister admin device so list backfill / re-register does not
    // immediately recreate an empty Client # for the same browser key.
    await this.adminClientDevicesService.unregisterBrowserKey(browserKey);

    return { success: true, id, browserKey };
  }

  private async resolveAdminInfoByBrowserKeys(
    browserKeys: string[],
    adminKeyToUserId: Map<string, number>,
  ): Promise<Map<string, AdminVisitorInfo>> {
    const result = new Map<string, AdminVisitorInfo>();
    const userIds = new Set<number>();

    for (const key of browserKeys) {
      const userId = adminKeyToUserId.get(key);
      if (userId) userIds.add(userId);
    }

    const devices =
      await this.adminClientDevicesService.getDevicesByBrowserKeys(browserKeys);

    if (!userIds.size && !devices.size) return result;

    const users = userIds.size
      ? await this.usersRepo.find({
          where: { id: In([...userIds]) },
          select: { id: true, email: true, firstName: true, lastName: true },
        })
      : [];
    const usersById = new Map(users.map((user) => [user.id, user]));

    for (const key of browserKeys) {
      const userId = adminKeyToUserId.get(key);
      const device = devices.get(key);
      const user = userId ? usersById.get(userId) : null;
      if (!user && !device) continue;
      result.set(key, {
        userId: user?.id ?? device?.adminUserId ?? 0,
        email: user?.email || '',
        name: user
          ? `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email
          : 'Admin',
        deviceId: device?.deviceId ?? null,
        deviceName: device?.deviceName ?? null,
        deviceType: device?.deviceType ?? null,
        deviceModel: device?.deviceModel ?? null,
        source: device?.source ?? null,
      });
    }

    return result;
  }
}
