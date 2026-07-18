import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { AnalyticsVisitor } from './entities/analytics-visitor.entity';
import { AnalyticsSession } from './entities/analytics-session.entity';
import { AnalyticsEvent } from './entities/analytics-event.entity';
import { CollectAnalyticsDto } from './dto/collect-analytics.dto';
import { ListVisitorsDto } from './dto/list-visitors.dto';
import { ListPopularProductsDto, parseIncludeAdminFlag } from './dto/list-popular-products.dto';
import { ListSearchQueriesDto } from './dto/list-search-queries.dto';
import { AdminClientDevicesService } from './admin-client-devices.service';
import { AnalyticsService } from './analytics.service';
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
    private readonly analyticsService: AnalyticsService,
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

    if (query.startDate && query.endDate) {
      const start = new Date(`${query.startDate}T00:00:00.000Z`).getTime();
      const end = new Date(`${query.endDate}T23:59:59.999Z`).getTime();
      pairs = pairs.filter((pair) => {
        const seen = new Date(pair.visitor.last_seen_at).getTime();
        return seen >= start && seen <= end;
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

  /**
   * Most popular products.
   * Views = Google Analytics screenPageViews on /products/{slug} (fallback: first-party page views)
   * Sessions / Client IDs / Clicks = first-party DB (respects with/without admin)
   */
  async listPopularProducts(query: ListPopularProductsDto) {
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 20));
    const includeAdmin = parseIncludeAdminFlag(query.includeAdmin);
    const sortBy = query.sortBy || 'views';
    const sortOrder = query.sortOrder === 'asc' ? 'asc' : 'desc';
    const search = query.search?.trim().toLowerCase() || '';
    const startDate = query.startDate;
    const endDate = query.endDate;

    const [dbRows, adminStats, gaViews] = await Promise.all([
      this.queryProductAggregates({
        includeAdmin,
        startDate,
        endDate,
      }),
      this.queryProductAdminContribution({ startDate, endDate }),
      startDate && endDate
        ? this.analyticsService.getProductPageViewsBySlug(startDate, endDate)
        : Promise.resolve(new Map<string, number>()),
    ]);

    const byKey = new Map<
      string,
      {
        productId: number | null;
        slug: string | null;
        name: string;
        nameAr: string | null;
        views: number;
        dbViews: number;
        gaViews: number;
        sessions: number;
        clicks: number;
        clientIds: number;
      }
    >();

    for (const row of dbRows) {
      const slug = row.slug || null;
      const key = slug || `id:${row.productId}`;
      const ga = slug ? gaViews.get(slug) || 0 : 0;
      byKey.set(key, {
        productId: row.productId,
        slug,
        name: row.name,
        nameAr: row.nameAr,
        dbViews: row.views,
        gaViews: ga,
        views: row.views,
        sessions: row.sessions,
        clicks: row.clicks,
        clientIds: row.clientIds,
      });
    }

    const missingGaSlugs = [...gaViews.entries()]
      .filter(([slug, ga]) => ga > 0 && !byKey.has(slug))
      .map(([slug]) => slug);

    const gaOnlyProducts =
      missingGaSlugs.length > 0
        ? ((await this.dataSource.query(
            `SELECT id, slug, name_en, name_ar FROM products
             WHERE slug = ANY($1::text[]) AND deleted_at IS NULL`,
            [missingGaSlugs],
          )) as Array<{
            id: number;
            slug: string;
            name_en: string;
            name_ar: string;
          }>)
        : [];
    const gaOnlyBySlug = new Map(gaOnlyProducts.map((p) => [p.slug, p]));

    for (const [slug, ga] of gaViews) {
      if (ga <= 0) continue;
      const existing = byKey.get(slug);
      if (existing) {
        existing.gaViews = ga;
        continue;
      }
      const p = gaOnlyBySlug.get(slug);
      byKey.set(slug, {
        productId: p?.id ?? null,
        slug,
        name: p?.name_en || p?.name_ar || slug,
        nameAr: p?.name_ar || p?.name_en || null,
        dbViews: 0,
        gaViews: ga,
        views: 0,
        sessions: 0,
        clicks: 0,
        clientIds: 0,
      });
    }

    let items = [...byKey.values()];
    if (search) {
      items = items.filter((item) => {
        const hay = `${item.name} ${item.nameAr || ''} ${item.slug || ''} ${item.productId || ''}`.toLowerCase();
        return hay.includes(search);
      });
    }

    items.sort((a, b) => {
      const av =
        sortBy === 'sessions'
          ? a.sessions
          : sortBy === 'clientIds'
            ? a.clientIds
            : sortBy === 'clicks'
              ? a.clicks
              : a.views;
      const bv =
        sortBy === 'sessions'
          ? b.sessions
          : sortBy === 'clientIds'
            ? b.clientIds
            : sortBy === 'clicks'
              ? b.clicks
              : b.views;
      if (av !== bv) return sortOrder === 'asc' ? av - bv : bv - av;
      if (a.views !== b.views) return b.views - a.views;
      return (a.slug || '').localeCompare(b.slug || '');
    });

    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const offset = (page - 1) * limit;
    const pageItems = items.slice(offset, offset + limit).map((item) => ({
      productId: item.productId,
      slug: item.slug,
      name: item.name,
      nameAr: item.nameAr,
      views: item.dbViews,
      gaViews: item.gaViews,
      sessions: item.sessions,
      clicks: item.clicks,
      clientIds: item.clientIds,
      viewsSource: 'first_party' as const,
    }));

    const totalSessions = items.reduce((sum, i) => sum + i.sessions, 0);
    const totalClicks = items.reduce((sum, i) => sum + i.clicks, 0);
    const totalDbViews = items.reduce((sum, i) => sum + i.dbViews, 0);

    return {
      data: pageItems,
      meta: {
        total,
        page,
        limit,
        totalPages,
        includeAdmin,
        sortBy,
        sortOrder,
        viewsSource: 'first_party',
        totals: {
          views: totalDbViews,
          sessions: totalSessions,
          clicks: totalClicks,
        },
        adminContribution: adminStats,
        toggleHasEffect: adminStats.adminViews > 0 || adminStats.adminClicks > 0,
      },
    };
  }

  async listSearchQueries(query: ListSearchQueriesDto) {
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 20));
    const offset = (page - 1) * limit;
    // Defensive: query-string includeAdmin must be parsed as 0/1 (not Boolean("false")).
    const includeAdmin = parseIncludeAdminFlag(query.includeAdmin);
    const sortBy = query.sortBy || 'views';
    const sortOrder = query.sortOrder === 'asc' ? 'ASC' : 'DESC';
    const search = query.search?.trim() || '';

    const params: unknown[] = [];
    const push = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };

    const startParam = query.startDate
      ? push(`${query.startDate}T00:00:00.000Z`)
      : null;
    const endParam = query.endDate
      ? push(`${query.endDate}T23:59:59.999Z`)
      : null;
    const searchParam = search ? push(`%${search}%`) : null;

    const dateFilter = [
      startParam ? `e.occurred_at >= ${startParam}::timestamptz` : null,
      endParam ? `e.occurred_at <= ${endParam}::timestamptz` : null,
    ]
      .filter(Boolean)
      .join(' AND ');

    const adminFilter = includeAdmin
      ? 'TRUE'
      : `NOT EXISTS (
          SELECT 1
          FROM analytics_visitors v
          INNER JOIN admin_client_devices d ON d.browser_key = v.browser_key
          WHERE v.id = e.visitor_id
        )`;

    const sortColumn =
      sortBy === 'sessions'
        ? 'sessions'
        : sortBy === 'clientIds'
          ? '"clientIds"'
          : 'views';

    // Only real search submits (`Searched: …`), not filter/sort events that carry search_term.
    const searchEventFilter = `e.event_name ILIKE 'Searched:%'`;

    const sql = `
      WITH searched AS (
        SELECT
          e.visitor_id,
          e.session_id,
          LOWER(TRIM(COALESCE(
            NULLIF(e.properties->>'search_term', ''),
            TRIM(SUBSTRING(e.event_name FROM 10)),
            ''
          ))) AS query_key,
          TRIM(COALESCE(
            NULLIF(e.properties->>'search_term', ''),
            TRIM(SUBSTRING(e.event_name FROM 10)),
            ''
          )) AS query_label
        FROM analytics_events e
        WHERE ${adminFilter}
          ${dateFilter ? `AND ${dateFilter}` : ''}
          AND ${searchEventFilter}
      ),
      aggregated AS (
        SELECT
          MAX(s.query_label) AS query,
          COUNT(*)::int AS views,
          COUNT(DISTINCT s.session_id)::int AS sessions,
          COUNT(DISTINCT s.visitor_id)::int AS "clientIds"
        FROM searched s
        WHERE s.query_key <> ''
        GROUP BY s.query_key
      )
      SELECT
        a.*,
        COUNT(*) OVER()::int AS "__total"
      FROM aggregated a
      WHERE (
        ${searchParam ? `a.query ILIKE ${searchParam}` : 'TRUE'}
      )
      ORDER BY ${sortColumn} ${sortOrder}, views DESC, query ASC
      LIMIT ${push(limit)}
      OFFSET ${push(offset)}
    `;

    const adminParams: unknown[] = [];
    if (query.startDate) adminParams.push(`${query.startDate}T00:00:00.000Z`);
    if (query.endDate) adminParams.push(`${query.endDate}T23:59:59.999Z`);
    const adminFilterDate = [
      query.startDate ? `e.occurred_at >= $1::timestamptz` : null,
      query.endDate
        ? `e.occurred_at <= $${query.startDate ? 2 : 1}::timestamptz`
        : null,
    ]
      .filter(Boolean)
      .join(' AND ');

    const [rows, adminStatsRows] = await Promise.all([
      this.dataSource.query(sql, params) as Promise<
        Array<{
          query: string;
          views: number;
          sessions: number;
          clientIds: number;
          __total: number;
        }>
      >,
      this.dataSource.query(
        `
      SELECT
        COUNT(*)::int AS "adminSearches",
        COUNT(DISTINCT e.visitor_id)::int AS "adminClientIds",
        COUNT(DISTINCT d.browser_key)::int AS "adminDevices"
      FROM analytics_events e
      INNER JOIN analytics_visitors v ON v.id = e.visitor_id
      INNER JOIN admin_client_devices d ON d.browser_key = v.browser_key
      WHERE ${searchEventFilter}
      ${adminFilterDate ? `AND ${adminFilterDate}` : ''}
    `,
        adminParams,
      ) as Promise<
        Array<{
          adminSearches: number;
          adminClientIds: number;
          adminDevices: number;
        }>
      >,
    ]);

    const adminStats = adminStatsRows[0] || {
      adminSearches: 0,
      adminClientIds: 0,
      adminDevices: 0,
    };

    const total = rows[0]?.__total ?? 0;
    return {
      data: rows.map(({ __total: _t, ...item }) => item),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        includeAdmin,
        sortBy,
        sortOrder: query.sortOrder === 'asc' ? 'asc' : 'desc',
        adminContribution: {
          adminSearches: Number(adminStats.adminSearches) || 0,
          adminClientIds: Number(adminStats.adminClientIds) || 0,
          adminDevices: Number(adminStats.adminDevices) || 0,
        },
        toggleHasEffect: (Number(adminStats.adminSearches) || 0) > 0,
      },
    };
  }

  async getDateCoverage(
    scope: 'overview' | 'products' | 'search' | 'visitors' | 'admins',
  ) {
    if (scope === 'overview') {
      return {
        scope,
        ...(await this.analyticsService.getGaDateCoverage()),
      };
    }

    const presets = [
      { key: '1d', label: 'Today', days: 1 },
      { key: '2d', label: '2 days', days: 2 },
      { key: '3d', label: '3 days', days: 3 },
      { key: '7d', label: '7 days', days: 7 },
      { key: '28d', label: '28 days', days: 28 },
      { key: '90d', label: '90 days', days: 90 },
      { key: '365d', label: '12 months', days: 365 },
    ];

    let boundsSql = `
      SELECT MIN(e.occurred_at) AS earliest, MAX(e.occurred_at) AS latest
      FROM analytics_events e
      WHERE TRUE
    `;

    if (scope === 'products') {
      boundsSql = `
        SELECT MIN(e.occurred_at) AS earliest, MAX(e.occurred_at) AS latest
        FROM analytics_events e
        WHERE (
          e.event_name ILIKE 'product_view%'
          OR e.event_name = 'product_card_click'
          OR (
            e.event_name ~* 'page[[:space:]_]*view'
            AND COALESCE(e.path, '') ~* '/(?:[a-z]{2}/)?products/[^/?#]+'
          )
        )
      `;
    } else if (scope === 'search') {
      boundsSql = `
        SELECT MIN(e.occurred_at) AS earliest, MAX(e.occurred_at) AS latest
        FROM analytics_events e
        WHERE e.event_name ILIKE 'Searched:%'
      `;
    } else if (scope === 'visitors') {
      boundsSql = `
        SELECT MIN(v.first_seen_at) AS earliest, MAX(v.last_seen_at) AS latest
        FROM analytics_visitors v
        WHERE NOT EXISTS (
          SELECT 1 FROM admin_client_devices d
          WHERE d.browser_key = v.browser_key
        )
      `;
    } else if (scope === 'admins') {
      boundsSql = `
        SELECT MIN(v.first_seen_at) AS earliest, MAX(v.last_seen_at) AS latest
        FROM analytics_visitors v
        WHERE EXISTS (
          SELECT 1 FROM admin_client_devices d
          WHERE d.browser_key = v.browser_key
        )
      `;
    }

    const bounds = (await this.dataSource.query(boundsSql)) as Array<{
      earliest: Date | null;
      latest: Date | null;
    }>;

    const earliest = bounds[0]?.earliest ? new Date(bounds[0].earliest) : null;
    const latest = bounds[0]?.latest ? new Date(bounds[0].latest) : null;
    const end = new Date();
    end.setUTCHours(0, 0, 0, 0);

    let spanDays = 0;
    if (earliest) {
      const earliestDay = new Date(earliest);
      earliestDay.setUTCHours(0, 0, 0, 0);
      spanDays = Math.max(
        1,
        Math.floor((end.getTime() - earliestDay.getTime()) / 86_400_000) + 1,
      );
    }

    const pills = presets
      .filter((preset) => spanDays > 0 && preset.days <= spanDays)
      .map((preset) => ({ ...preset, hasData: true }));

    const suggested = pills.length ? pills[pills.length - 1].key : null;

    return {
      scope,
      earliestAt: earliest ? earliest.toISOString() : null,
      latestAt: latest ? latest.toISOString() : null,
      spanDays,
      pills,
      suggested,
    };
  }

  private async queryProductAggregates(options: {
    includeAdmin: boolean;
    startDate?: string;
    endDate?: string;
  }) {
    const params: unknown[] = [];
    const push = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const startParam = options.startDate
      ? push(`${options.startDate}T00:00:00.000Z`)
      : null;
    const endParam = options.endDate
      ? push(`${options.endDate}T23:59:59.999Z`)
      : null;
    const dateFilter = [
      startParam ? `e.occurred_at >= ${startParam}::timestamptz` : null,
      endParam ? `e.occurred_at <= ${endParam}::timestamptz` : null,
    ]
      .filter(Boolean)
      .join(' AND ');

    const adminFilter = options.includeAdmin
      ? 'TRUE'
      : `NOT EXISTS (
          SELECT 1
          FROM analytics_visitors v
          INNER JOIN admin_client_devices d ON d.browser_key = v.browser_key
          WHERE v.id = e.visitor_id
        )`;

    const sql = `
      WITH raw_events AS (
        SELECT
          e.visitor_id,
          e.session_id,
          e.event_name,
          e.path,
          e.properties,
          CASE
            WHEN COALESCE(e.properties->>'product_id', '') ~ '^[0-9]+$'
              THEN (e.properties->>'product_id')::int
            ELSE NULL
          END AS prop_product_id,
          NULLIF(TRIM(COALESCE(e.properties->>'product_slug', '')), '') AS prop_slug,
          NULLIF(
            (regexp_match(COALESCE(e.path, ''), '/(?:[a-z]{2}/)?products/([^/?#]+)'))[1],
            ''
          ) AS path_slug,
          CASE
            WHEN e.event_name ILIKE 'product_view%'
              OR e.event_name ~* 'page[[:space:]_]*view'
              THEN true
            ELSE false
          END AS is_view,
          CASE WHEN e.event_name = 'product_card_click' THEN true ELSE false END AS is_click
        FROM analytics_events e
        WHERE ${adminFilter}
          ${dateFilter ? `AND ${dateFilter}` : ''}
          AND (
            e.event_name ILIKE 'product_view%'
            OR e.event_name ~* 'page[[:space:]_]*view'
            OR e.event_name = 'product_card_click'
          )
          AND (
            e.event_name = 'product_card_click'
            OR e.event_name ILIKE 'product_view%'
            OR COALESCE(e.path, '') ~* '/(?:[a-z]{2}/)?products/[^/?#]+'
          )
      ),
      resolved AS (
        SELECT
          re.*,
          COALESCE(re.prop_product_id, p_by_prop.id, p_by_path.id) AS product_id,
          COALESCE(re.prop_slug, re.path_slug, p_by_prop.slug, p_by_path.slug) AS product_slug
        FROM raw_events re
        LEFT JOIN products p_by_prop
          ON re.prop_slug IS NOT NULL AND p_by_prop.slug = re.prop_slug AND p_by_prop.deleted_at IS NULL
        LEFT JOIN products p_by_path
          ON re.path_slug IS NOT NULL AND p_by_path.slug = re.path_slug AND p_by_path.deleted_at IS NULL
        WHERE re.is_view OR re.is_click
      )
      SELECT
        r.product_id AS "productId",
        COALESCE(p.slug, MAX(r.product_slug)) AS slug,
        COALESCE(p.name_en, p.name_ar, MAX(r.product_slug), CONCAT('#', r.product_id::text)) AS name,
        COALESCE(p.name_ar, p.name_en) AS "nameAr",
        COUNT(*) FILTER (WHERE r.is_view)::int AS views,
        COUNT(DISTINCT r.session_id) FILTER (WHERE r.is_view)::int AS sessions,
        COUNT(*) FILTER (WHERE r.is_click)::int AS clicks,
        -- Distinct Client #s who viewed the product (not only card-clicks)
        COUNT(DISTINCT r.visitor_id) FILTER (WHERE r.is_view)::int AS "clientIds"
      FROM resolved r
      LEFT JOIN products p ON p.id = r.product_id AND p.deleted_at IS NULL
      WHERE r.product_id IS NOT NULL OR r.product_slug IS NOT NULL
      GROUP BY r.product_id, p.id, p.slug, p.name_en, p.name_ar
    `;

    return (await this.dataSource.query(sql, params)) as Array<{
      productId: number | null;
      slug: string | null;
      name: string;
      nameAr: string | null;
      views: number;
      sessions: number;
      clicks: number;
      clientIds: number;
    }>;
  }

  private async queryProductAdminContribution(options: {
    startDate?: string;
    endDate?: string;
  }) {
    const params: unknown[] = [];
    const push = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const startParam = options.startDate
      ? push(`${options.startDate}T00:00:00.000Z`)
      : null;
    const endParam = options.endDate
      ? push(`${options.endDate}T23:59:59.999Z`)
      : null;
    const dateFilter = [
      startParam ? `e.occurred_at >= ${startParam}::timestamptz` : null,
      endParam ? `e.occurred_at <= ${endParam}::timestamptz` : null,
    ]
      .filter(Boolean)
      .join(' AND ');

    const rows = (await this.dataSource.query(
      `
      SELECT
        COUNT(*) FILTER (
          WHERE e.event_name ILIKE 'product_view%'
             OR e.event_name ~* 'page[[:space:]_]*view'
        )::int AS "adminViews",
        COUNT(*) FILTER (WHERE e.event_name = 'product_card_click')::int AS "adminClicks",
        COUNT(DISTINCT e.visitor_id)::int AS "adminClientIds",
        COUNT(DISTINCT d.browser_key)::int AS "adminDevices"
      FROM analytics_events e
      INNER JOIN analytics_visitors v ON v.id = e.visitor_id
      INNER JOIN admin_client_devices d ON d.browser_key = v.browser_key
      WHERE (
        e.event_name ILIKE 'product_view%'
        OR e.event_name = 'product_card_click'
        OR (
          e.event_name ~* 'page[[:space:]_]*view'
          AND COALESCE(e.path, '') ~* '/(?:[a-z]{2}/)?products/[^/?#]+'
        )
      )
      ${dateFilter ? `AND ${dateFilter}` : ''}
    `,
      params,
    )) as Array<{
      adminViews: number;
      adminClicks: number;
      adminClientIds: number;
      adminDevices: number;
    }>;

    const row = rows[0] || {
      adminViews: 0,
      adminClicks: 0,
      adminClientIds: 0,
      adminDevices: 0,
    };
    return {
      adminViews: Number(row.adminViews) || 0,
      adminClicks: Number(row.adminClicks) || 0,
      adminClientIds: Number(row.adminClientIds) || 0,
      adminDevices: Number(row.adminDevices) || 0,
    };
  }

  /**
   * Sessions that added to cart or reached checkout (one row per session).
   */
  async listFunnelSessions(query: {
    kind: 'add_to_cart' | 'checkout';
    page?: number;
    limit?: number;
    startDate?: string;
    endDate?: string;
    search?: string;
    includeAdmin?: number | boolean | string;
    sortBy?: 'startedAt' | 'lastSeen' | 'events' | 'clientId';
    sortOrder?: 'asc' | 'desc';
  }) {
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 20));
    const offset = (page - 1) * limit;
    const includeAdmin = parseIncludeAdminFlag(query.includeAdmin);
    const sortBy = query.sortBy || 'lastSeen';
    const sortOrder = query.sortOrder === 'asc' ? 'ASC' : 'DESC';
    const search = query.search?.trim() || '';

    const params: unknown[] = [];
    const push = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };

    const startParam = query.startDate
      ? push(`${query.startDate}T00:00:00.000Z`)
      : null;
    const endParam = query.endDate
      ? push(`${query.endDate}T23:59:59.999Z`)
      : null;
    const searchParam = search ? push(`%${search}%`) : null;

    const dateFilter = [
      startParam ? `e.occurred_at >= ${startParam}::timestamptz` : null,
      endParam ? `e.occurred_at <= ${endParam}::timestamptz` : null,
    ]
      .filter(Boolean)
      .join(' AND ');

    const adminFilter = includeAdmin
      ? 'TRUE'
      : `NOT EXISTS (
          SELECT 1 FROM admin_client_devices d
          WHERE d.browser_key = v.browser_key
        )`;

    const kindFilter =
      query.kind === 'add_to_cart'
        ? `e.event_name = 'add_to_cart_click'`
        : `(
            e.event_name ILIKE 'Checkout%'
            OR e.event_name ILIKE 'Order %'
            OR e.event_name ILIKE 'Order succeeded%'
            OR e.event_name ILIKE 'Order failed%'
            OR e.event_name ILIKE 'Order validation%'
            OR (
              e.event_name ~* 'page[[:space:]_]*view'
              AND COALESCE(e.path, '') ~* '/checkout'
            )
          )`;

    const sortColumn =
      sortBy === 'startedAt'
        ? '"startedAt"'
        : sortBy === 'events'
          ? '"eventCount"'
          : sortBy === 'clientId'
            ? '"clientId"'
            : '"lastSeenAt"';

    const sql = `
      WITH matched AS (
        SELECT
          e.visitor_id,
          e.session_id,
          COUNT(*)::int AS match_count,
          MIN(e.occurred_at) AS first_match_at,
          MAX(e.occurred_at) AS last_match_at,
          (ARRAY_AGG(e.event_name ORDER BY e.occurred_at DESC))[1] AS last_event_name,
          (ARRAY_AGG(e.path ORDER BY e.occurred_at DESC))[1] AS last_path,
          (ARRAY_AGG(e.properties->>'product_name' ORDER BY e.occurred_at DESC)
            FILTER (WHERE e.properties->>'product_name' IS NOT NULL))[1] AS product_name,
          (ARRAY_AGG(e.properties->>'product_id' ORDER BY e.occurred_at DESC)
            FILTER (WHERE e.properties->>'product_id' IS NOT NULL))[1] AS product_id
        FROM analytics_events e
        INNER JOIN analytics_visitors v ON v.id = e.visitor_id
        WHERE ${kindFilter}
          AND ${adminFilter}
          ${dateFilter ? `AND ${dateFilter}` : ''}
        GROUP BY e.visitor_id, e.session_id
      )
      SELECT
        m.visitor_id AS "clientId",
        m.session_id AS "sessionId",
        s.session_key AS "sessionKey",
        m.match_count AS "matchCount",
        m.first_match_at AS "firstMatchAt",
        m.last_match_at AS "lastMatchAt",
        m.last_event_name AS "lastEventName",
        m.last_path AS "lastPath",
        m.product_name AS "productName",
        CASE
          WHEN COALESCE(m.product_id, '') ~ '^[0-9]+$' THEN m.product_id::int
          ELSE NULL
        END AS "productId",
        s.landing_path AS "landingPath",
        s.exit_path AS "exitPath",
        s.event_count AS "eventCount",
        s.page_view_count AS "pageViewCount",
        s.duration_seconds AS "durationSeconds",
        s.started_at AS "startedAt",
        s.last_seen_at AS "lastSeenAt",
        COUNT(*) OVER()::int AS "__total"
      FROM matched m
      INNER JOIN analytics_sessions s ON s.id = m.session_id
      INNER JOIN analytics_visitors v ON v.id = m.visitor_id
      WHERE (
        ${
          searchParam
            ? `(
                m.visitor_id::text ILIKE ${searchParam}
                OR m.session_id::text ILIKE ${searchParam}
                OR COALESCE(m.product_name, '') ILIKE ${searchParam}
                OR COALESCE(m.last_path, '') ILIKE ${searchParam}
                OR COALESCE(s.landing_path, '') ILIKE ${searchParam}
              )`
            : 'TRUE'
        }
      )
      ORDER BY ${sortColumn} ${sortOrder}, m.session_id DESC
      LIMIT ${push(limit)}
      OFFSET ${push(offset)}
    `;

    const rows = (await this.dataSource.query(sql, params)) as Array<{
      clientId: number;
      sessionId: number;
      sessionKey: string;
      matchCount: number;
      firstMatchAt: Date;
      lastMatchAt: Date;
      lastEventName: string;
      lastPath: string | null;
      productName: string | null;
      productId: number | null;
      landingPath: string | null;
      exitPath: string | null;
      eventCount: number;
      pageViewCount: number;
      durationSeconds: number;
      startedAt: Date;
      lastSeenAt: Date;
      __total: number;
    }>;

    const total = rows[0]?.__total ?? 0;
    return {
      data: rows.map(({ __total: _t, ...row }) => ({
        ...row,
        kind: query.kind,
      })),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        kind: query.kind,
        includeAdmin,
        sortBy,
        sortOrder: query.sortOrder === 'asc' ? 'asc' : 'desc',
      },
    };
  }

  /**
   * Page views on storefront footer pages only (about, contact, FAQs, shipping, legal).
   * One row per page-view event: page name + client id.
   */
  async listFooterPageViews(query: {
    page?: number;
    limit?: number;
    startDate?: string;
    endDate?: string;
    search?: string;
    includeAdmin?: number | boolean | string;
    sortBy?: 'occurredAt' | 'clientId' | 'pageName';
    sortOrder?: 'asc' | 'desc';
  }) {
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 20));
    const offset = (page - 1) * limit;
    const includeAdmin = parseIncludeAdminFlag(query.includeAdmin);
    const sortBy = query.sortBy || 'occurredAt';
    const sortOrder = query.sortOrder === 'asc' ? 'ASC' : 'DESC';
    const search = query.search?.trim() || '';

    const params: unknown[] = [];
    const push = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };

    const startParam = query.startDate
      ? push(`${query.startDate}T00:00:00.000Z`)
      : null;
    const endParam = query.endDate
      ? push(`${query.endDate}T23:59:59.999Z`)
      : null;
    const searchParam = search ? push(`%${search}%`) : null;

    const dateFilter = [
      startParam ? `e.occurred_at >= ${startParam}::timestamptz` : null,
      endParam ? `e.occurred_at <= ${endParam}::timestamptz` : null,
    ]
      .filter(Boolean)
      .join(' AND ');

    const adminFilter = includeAdmin
      ? 'TRUE'
      : `NOT EXISTS (
          SELECT 1 FROM admin_client_devices d
          WHERE d.browser_key = v.browser_key
        )`;

    // Match footer routes with optional locale prefix and full Page URL storage.
    const footerPathFilter = `
      COALESCE(e.path, '') ~*
      '(^|/)(en|ar)?/?(contact|faqs|shipping|about|privacy|terms|cookies|accessibility)([/?#]|$)'
    `;

    const pageKeyExpr = `
      lower((
        regexp_match(
          COALESCE(e.path, ''),
          '(?:^|/)(?:en|ar)?/?(contact|faqs|shipping|about|privacy|terms|cookies|accessibility)(?:[/?#]|$)',
          'i'
        )
      )[1])
    `;

    const pageNameExpr = `
      CASE ${pageKeyExpr}
        WHEN 'contact' THEN 'Contact Us'
        WHEN 'faqs' THEN 'FAQ'
        WHEN 'shipping' THEN 'Shipping Information'
        WHEN 'about' THEN 'About Us'
        WHEN 'privacy' THEN 'Privacy Policy'
        WHEN 'terms' THEN 'Terms of Service'
        WHEN 'cookies' THEN 'Cookie Policy'
        WHEN 'accessibility' THEN 'Accessibility'
        ELSE COALESCE(initcap(${pageKeyExpr}), 'Unknown')
      END
    `;

    const sortColumn =
      sortBy === 'clientId'
        ? '"clientId"'
        : sortBy === 'pageName'
          ? '"pageName"'
          : '"occurredAt"';

    const sql = `
      SELECT
        e.id AS "eventId",
        e.visitor_id AS "clientId",
        e.session_id AS "sessionId",
        ${pageKeyExpr} AS "pageKey",
        ${pageNameExpr} AS "pageName",
        e.path AS "path",
        e.occurred_at AS "occurredAt",
        COUNT(*) OVER()::int AS "__total"
      FROM analytics_events e
      INNER JOIN analytics_visitors v ON v.id = e.visitor_id
      WHERE e.event_name ~* 'page[[:space:]_]*view'
        AND ${footerPathFilter}
        AND ${adminFilter}
        ${dateFilter ? `AND ${dateFilter}` : ''}
        AND (
          ${
            searchParam
              ? `(
                  e.visitor_id::text ILIKE ${searchParam}
                  OR ${pageNameExpr} ILIKE ${searchParam}
                  OR COALESCE(e.path, '') ILIKE ${searchParam}
                )`
              : 'TRUE'
          }
        )
      ORDER BY ${sortColumn} ${sortOrder}, e.id DESC
      LIMIT ${push(limit)}
      OFFSET ${push(offset)}
    `;

    const rows = (await this.dataSource.query(sql, params)) as Array<{
      eventId: number;
      clientId: number;
      sessionId: number;
      pageKey: string | null;
      pageName: string;
      path: string | null;
      occurredAt: Date;
      __total: number;
    }>;

    const total = rows[0]?.__total ?? 0;
    return {
      data: rows.map(({ __total: _t, ...row }) => row),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        includeAdmin,
        sortBy,
        sortOrder: query.sortOrder === 'asc' ? 'asc' : 'desc',
      },
    };
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
