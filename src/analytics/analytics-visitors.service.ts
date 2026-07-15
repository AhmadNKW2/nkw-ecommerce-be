import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AnalyticsVisitor } from './entities/analytics-visitor.entity';
import { AnalyticsSession } from './entities/analytics-session.entity';
import { AnalyticsEvent } from './entities/analytics-event.entity';
import { CollectAnalyticsDto } from './dto/collect-analytics.dto';
import { ListVisitorsDto } from './dto/list-visitors.dto';
import { AdminClientDevicesService } from './admin-client-devices.service';
import { SettingsService } from '../settings/settings.service';
import { User } from '../users/entities/user.entity';

type AdminVisitorInfo = {
  userId: number;
  email: string;
  name: string;
};

@Injectable()
export class AnalyticsVisitorsService {
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
    private readonly settingsService: SettingsService,
  ) {}

  async collect(dto: CollectAnalyticsDto) {
    // Admin devices are still collected so journeys exist when
    // "show admin visitors" is enabled. Visibility is controlled at list/detail.
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

    let visitor = await this.visitorsRepo.findOne({
      where: { browser_key: dto.browserKey },
    });

    const latestPath =
      [...events].reverse().find((event) => event.path)?.path || null;

    if (!visitor) {
      visitor = this.visitorsRepo.create({
        browser_key: dto.browserKey,
        user_id: dto.userId ?? null,
        user_agent: dto.userAgent?.slice(0, 512) || null,
        last_path: latestPath,
        event_count: 0,
        session_count: 0,
        first_seen_at: events[0].occurredAt,
        last_seen_at: events[events.length - 1].occurredAt,
      });
      visitor = await this.visitorsRepo.save(visitor);
    } else {
      visitor.user_id = dto.userId ?? visitor.user_id;
      if (dto.userAgent) {
        visitor.user_agent = dto.userAgent.slice(0, 512);
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
    visitor.last_seen_at = session.last_seen_at;
    await this.visitorsRepo.save(visitor);

    return { accepted: events.length, visitorId: visitor.id, sessionId: session.id };
  }

  async listVisitors(query: ListVisitorsDto) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const showAdminVisitors = await this.isShowAdminVisitorsEnabled();
    const adminKeyToUserId =
      await this.adminClientDevicesService.getAdminUserIdByBrowserKey();
    const adminKeys = [...adminKeyToUserId.keys()];

    const qb = this.visitorsRepo
      .createQueryBuilder('visitor')
      .orderBy('visitor.last_seen_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (!showAdminVisitors && adminKeys.length) {
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
      } else if (showAdminVisitors) {
        qb.andWhere(
          `(visitor.last_path ILIKE :path OR visitor.browser_key IN (
            SELECT d.browser_key FROM admin_client_devices d
            INNER JOIN users u ON u.id = d.admin_user_id
            WHERE u.email ILIKE :adminTerm
               OR u."firstName" ILIKE :adminTerm
               OR u."lastName" ILIKE :adminTerm
          ))`,
          { path: `%${term}%`, adminTerm: `%${term}%` },
        );
      } else {
        qb.andWhere('visitor.last_path ILIKE :path', { path: `%${term}%` });
      }
    }

    const [rows, total] = await qb.getManyAndCount();
    const adminInfoByBrowserKey = showAdminVisitors
      ? await this.resolveAdminInfoByBrowserKeys(
          rows.map((row) => row.browser_key),
          adminKeyToUserId,
        )
      : new Map<string, AdminVisitorInfo>();

    const visitorIds = rows.map((row) => row.id);
    const sessions =
      visitorIds.length === 0
        ? []
        : await this.sessionsRepo
            .createQueryBuilder('session')
            .where('session.visitor_id IN (:...visitorIds)', { visitorIds })
            .getMany();

    const durationByVisitor = new Map<number, number>();
    for (const session of sessions) {
      durationByVisitor.set(
        session.visitor_id,
        (durationByVisitor.get(session.visitor_id) || 0) +
          (session.duration_seconds || 0),
      );
    }

    return {
      data: rows.map((visitor) => {
        const admin = adminInfoByBrowserKey.get(visitor.browser_key) || null;
        return {
          id: visitor.id,
          userId: visitor.user_id,
          lastPath: visitor.last_path,
          eventCount: visitor.event_count,
          sessionCount: visitor.session_count,
          totalDurationSeconds: durationByVisitor.get(visitor.id) || 0,
          firstSeenAt: visitor.first_seen_at,
          lastSeenAt: visitor.last_seen_at,
          userAgent: visitor.user_agent,
          isAdmin: Boolean(admin),
          admin,
        };
      }),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        showAdminVisitors,
      },
    };
  }

  async getVisitor(id: number) {
    const visitor = await this.visitorsRepo.findOne({ where: { id } });
    if (!visitor) {
      throw new NotFoundException(`Visitor #${id} not found`);
    }

    const showAdminVisitors = await this.isShowAdminVisitorsEnabled();
    const isAdmin = await this.adminClientDevicesService.isAdminBrowserKey(
      visitor.browser_key,
    );

    if (isAdmin && !showAdminVisitors) {
      throw new NotFoundException(`Visitor #${id} not found`);
    }

    const adminInfoByBrowserKey = showAdminVisitors
      ? await this.resolveAdminInfoByBrowserKeys(
          [visitor.browser_key],
          await this.adminClientDevicesService.getAdminUserIdByBrowserKey(),
        )
      : new Map<string, AdminVisitorInfo>();
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

    return {
      id: visitor.id,
      userId: visitor.user_id,
      lastPath: visitor.last_path,
      eventCount: visitor.event_count,
      sessionCount: visitor.session_count,
      totalDurationSeconds,
      firstSeenAt: visitor.first_seen_at,
      lastSeenAt: visitor.last_seen_at,
      userAgent: visitor.user_agent,
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

    await this.eventsRepo.delete({ visitor_id: id });
    await this.sessionsRepo.delete({ visitor_id: id });
    await this.visitorsRepo.delete({ id });

    return { success: true, id };
  }

  private async isShowAdminVisitorsEnabled(): Promise<boolean> {
    const toggles = await this.settingsService.getProductFieldToggles();
    return Boolean(toggles.show_admin_visitors_enabled);
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

    if (!userIds.size) return result;

    const users = await this.usersRepo.find({
      where: { id: In([...userIds]) },
      select: { id: true, email: true, firstName: true, lastName: true },
    });
    const usersById = new Map(users.map((user) => [user.id, user]));

    for (const key of browserKeys) {
      const userId = adminKeyToUserId.get(key);
      if (!userId) continue;
      const user = usersById.get(userId);
      if (!user) continue;
      result.set(key, {
        userId: user.id,
        email: user.email,
        name: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email,
      });
    }

    return result;
  }
}
