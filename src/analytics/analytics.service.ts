import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { existsSync, readFileSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';
import type {
  AnalyticsKpi,
  AnalyticsNamedValue,
  AnalyticsOverview,
  AnalyticsTimePoint,
} from './analytics.types';

type DateWindow = {
  startDate: string;
  endDate: string;
  previousStartDate: string;
  previousEndDate: string;
  label: string;
};

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);
  private client: BetaAnalyticsDataClient | null = null;
  private readonly propertyId: string;

  constructor(private readonly configService: ConfigService) {
    this.propertyId = (
      this.configService.get<string>('GA4_PROPERTY_ID') || ''
    ).trim();
  }

  async getOverview(query: AnalyticsQueryDto): Promise<AnalyticsOverview> {
    const client = this.getClient();
    const property = `properties/${this.propertyId}`;
    const range = this.resolveDateWindow(query);

    const [
      currentTotals,
      previousTotals,
      timeseriesRows,
      topPages,
      trafficSources,
      devices,
      countries,
      events,
    ] = await Promise.all([
      this.runTotals(client, property, range.startDate, range.endDate),
      this.runTotals(
        client,
        property,
        range.previousStartDate,
        range.previousEndDate,
      ),
      this.runTimeseries(client, property, range.startDate, range.endDate),
      this.runDimensionReport(
        client,
        property,
        range.startDate,
        range.endDate,
        'pagePath',
        'screenPageViews',
        10,
      ),
      this.runDimensionReport(
        client,
        property,
        range.startDate,
        range.endDate,
        'sessionDefaultChannelGroup',
        'sessions',
        10,
      ),
      this.runDimensionReport(
        client,
        property,
        range.startDate,
        range.endDate,
        'deviceCategory',
        'sessions',
        5,
      ),
      this.runDimensionReport(
        client,
        property,
        range.startDate,
        range.endDate,
        'country',
        'activeUsers',
        10,
      ),
      this.runDimensionReport(
        client,
        property,
        range.startDate,
        range.endDate,
        'eventName',
        'eventCount',
        12,
      ),
    ]);

    return {
      propertyId: this.propertyId,
      range,
      kpis: this.buildKpis(currentTotals, previousTotals),
      timeseries: timeseriesRows,
      topPages,
      trafficSources,
      devices,
      countries,
      events,
    };
  }

  private getClient(): BetaAnalyticsDataClient {
    if (this.client) {
      return this.client;
    }

    if (!this.propertyId) {
      throw new ServiceUnavailableException(
        'GA4_PROPERTY_ID is not configured',
      );
    }

    const credentialsJson = (
      this.configService.get<string>('GA4_CREDENTIALS_JSON') || ''
    ).trim();
    const credentialsPath = (
      this.configService.get<string>('GA4_CREDENTIALS_PATH') || ''
    ).trim();

    try {
      // Use REST transport (`fallback: true`). gRPC can fail with a misleading
      // SERVICE_DISABLED error against this service account/project combo.
      if (credentialsJson) {
        const parsed = this.parseCredentialsJson(credentialsJson);
        this.client = new BetaAnalyticsDataClient({
          credentials: parsed as any,
          fallback: true,
        });
        return this.client;
      }

      if (credentialsPath) {
        const absolutePath = isAbsolute(credentialsPath)
          ? credentialsPath
          : resolve(process.cwd(), credentialsPath);

        if (!existsSync(absolutePath)) {
          throw new ServiceUnavailableException(
            `GA4 credentials file not found at ${absolutePath}`,
          );
        }

        // Validate JSON early for clearer errors
        JSON.parse(readFileSync(absolutePath, 'utf8'));
        this.client = new BetaAnalyticsDataClient({
          keyFilename: absolutePath,
          fallback: true,
        });
        return this.client;
      }
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }
      this.logger.error('Failed to initialize GA4 client', error as Error);
      throw new ServiceUnavailableException(
        'Failed to initialize Google Analytics credentials',
      );
    }

    throw new ServiceUnavailableException(
      'Set GA4_CREDENTIALS_PATH or GA4_CREDENTIALS_JSON',
    );
  }

  private resolveDateWindow(query: AnalyticsQueryDto): DateWindow {
    if (query.startDate && query.endDate) {
      const start = this.parseYmd(query.startDate);
      const end = this.parseYmd(query.endDate);
      if (start.getTime() > end.getTime()) {
        throw new ServiceUnavailableException(
          'startDate must be on or before endDate',
        );
      }
      const days =
        Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
      const previousEnd = this.addDays(start, -1);
      const previousStart = this.addDays(previousEnd, -(days - 1));
      return {
        startDate: query.startDate,
        endDate: query.endDate,
        previousStartDate: this.formatYmd(previousStart),
        previousEndDate: this.formatYmd(previousEnd),
        label: `${query.startDate} → ${query.endDate}`,
      };
    }

    const daysByRange: Record<string, number> = {
      '7d': 7,
      '28d': 28,
      '90d': 90,
      '365d': 365,
    };
    const days = daysByRange[query.range || '28d'] || 28;
    const end = this.startOfUtcDay(new Date());
    const start = this.addDays(end, -(days - 1));
    const previousEnd = this.addDays(start, -1);
    const previousStart = this.addDays(previousEnd, -(days - 1));

    return {
      startDate: this.formatYmd(start),
      endDate: this.formatYmd(end),
      previousStartDate: this.formatYmd(previousStart),
      previousEndDate: this.formatYmd(previousEnd),
      label: `Last ${days} days`,
    };
  }

  private async runTotals(
    client: BetaAnalyticsDataClient,
    property: string,
    startDate: string,
    endDate: string,
  ) {
    try {
      // GA4 allows at most 10 metrics per request.
      const [[primary], [secondary]] = await Promise.all([
        client.runReport({
          property,
          dateRanges: [{ startDate, endDate }],
          metrics: [
            { name: 'activeUsers' },
            { name: 'newUsers' },
            { name: 'sessions' },
            { name: 'screenPageViews' },
            { name: 'engagedSessions' },
            { name: 'bounceRate' },
            { name: 'averageSessionDuration' },
            { name: 'engagementRate' },
            { name: 'eventCount' },
            { name: 'conversions' },
          ],
        }),
        client.runReport({
          property,
          dateRanges: [{ startDate, endDate }],
          metrics: [{ name: 'totalRevenue' }],
        }),
      ]);

      const primaryValues = primary.rows?.[0]?.metricValues || [];
      const secondaryValues = secondary.rows?.[0]?.metricValues || [];
      return {
        activeUsers: this.toNumber(primaryValues[0]?.value),
        newUsers: this.toNumber(primaryValues[1]?.value),
        sessions: this.toNumber(primaryValues[2]?.value),
        pageViews: this.toNumber(primaryValues[3]?.value),
        engagedSessions: this.toNumber(primaryValues[4]?.value),
        bounceRate: this.toNumber(primaryValues[5]?.value),
        averageSessionDuration: this.toNumber(primaryValues[6]?.value),
        engagementRate: this.toNumber(primaryValues[7]?.value),
        eventCount: this.toNumber(primaryValues[8]?.value),
        conversions: this.toNumber(primaryValues[9]?.value),
        totalRevenue: this.toNumber(secondaryValues[0]?.value),
      };
    } catch (error) {
      this.logger.error('GA4 totals report failed', error as Error);
      throw new ServiceUnavailableException(
        this.gaErrorMessage(error, 'Failed to fetch GA4 totals'),
      );
    }
  }

  private async runTimeseries(
    client: BetaAnalyticsDataClient,
    property: string,
    startDate: string,
    endDate: string,
  ): Promise<AnalyticsTimePoint[]> {
    try {
      const [response] = await client.runReport({
        property,
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: 'date' }],
        metrics: [
          { name: 'activeUsers' },
          { name: 'sessions' },
          { name: 'screenPageViews' },
          { name: 'engagedSessions' },
        ],
        orderBys: [{ dimension: { dimensionName: 'date' } }],
      });

      return (response.rows || []).map((row) => {
        const dateRaw = row.dimensionValues?.[0]?.value || '';
        const metrics = row.metricValues || [];
        return {
          date: this.formatGaDate(dateRaw),
          activeUsers: this.toNumber(metrics[0]?.value),
          sessions: this.toNumber(metrics[1]?.value),
          pageViews: this.toNumber(metrics[2]?.value),
          engagedSessions: this.toNumber(metrics[3]?.value),
        };
      });
    } catch (error) {
      this.logger.error('GA4 timeseries report failed', error as Error);
      throw new ServiceUnavailableException(
        this.gaErrorMessage(error, 'Failed to fetch GA4 timeseries'),
      );
    }
  }

  private async runDimensionReport(
    client: BetaAnalyticsDataClient,
    property: string,
    startDate: string,
    endDate: string,
    dimension: string,
    metric: string,
    limit: number,
  ): Promise<AnalyticsNamedValue[]> {
    try {
      const [response] = await client.runReport({
        property,
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: dimension }],
        metrics: [{ name: metric }],
        limit,
        orderBys: [{ metric: { metricName: metric }, desc: true }],
      });

      return (response.rows || []).map((row) => ({
        name: row.dimensionValues?.[0]?.value || '(not set)',
        value: this.toNumber(row.metricValues?.[0]?.value),
      }));
    } catch (error) {
      this.logger.error(
        `GA4 dimension report failed (${dimension})`,
        error as Error,
      );
      throw new ServiceUnavailableException(
        this.gaErrorMessage(error, `Failed to fetch GA4 ${dimension}`),
      );
    }
  }

  private buildKpis(
    current: Awaited<ReturnType<AnalyticsService['runTotals']>>,
    previous: Awaited<ReturnType<AnalyticsService['runTotals']>>,
  ): AnalyticsKpi[] {
    const defs: Array<{
      key: keyof typeof current;
      label: string;
      format: AnalyticsKpi['format'];
    }> = [
      { key: 'activeUsers', label: 'Active users', format: 'number' },
      { key: 'newUsers', label: 'New users', format: 'number' },
      { key: 'sessions', label: 'Sessions', format: 'number' },
      { key: 'pageViews', label: 'Page views', format: 'number' },
      { key: 'engagedSessions', label: 'Engaged sessions', format: 'number' },
      { key: 'bounceRate', label: 'Bounce rate', format: 'percent' },
      {
        key: 'averageSessionDuration',
        label: 'Avg. session',
        format: 'duration',
      },
      { key: 'engagementRate', label: 'Engagement rate', format: 'percent' },
      { key: 'eventCount', label: 'Events', format: 'number' },
      { key: 'conversions', label: 'Conversions', format: 'number' },
      { key: 'totalRevenue', label: 'Revenue', format: 'decimal' },
    ];

    return defs.map((def) => {
      const value = current[def.key];
      const previousValue = previous[def.key];
      return {
        label: def.label,
        key: def.key,
        value,
        previousValue,
        changePercent: this.changePercent(value, previousValue),
        format: def.format,
      };
    });
  }

  private changePercent(current: number, previous: number): number | null {
    if (previous === 0) {
      return current === 0 ? 0 : null;
    }
    return ((current - previous) / previous) * 100;
  }

  private toNumber(value?: string | null): number {
    if (value == null || value === '') return 0;
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  private formatGaDate(raw: string): string {
    if (/^\d{8}$/.test(raw)) {
      return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    }
    return raw;
  }

  private parseYmd(value: string): Date {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }

  private formatYmd(date: Date): string {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  private startOfUtcDay(date: Date): Date {
    return new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
  }

  private addDays(date: Date, days: number): Date {
    const next = new Date(date.getTime());
    next.setUTCDate(next.getUTCDate() + days);
    return next;
  }

  private parseCredentialsJson(
    credentialsJson: string,
  ): Record<string, unknown> {
    const parsed = JSON.parse(credentialsJson) as Record<string, unknown>;
    if (typeof parsed.private_key === 'string') {
      // Railway / env paste sometimes keeps literal "\n" sequences.
      parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    }
    return parsed;
  }

  private gaErrorMessage(error: unknown, fallback: string): string {
    const message =
      error && typeof error === 'object' && 'message' in error
        ? String((error as { message?: unknown }).message || '')
        : '';

    let detail = message;
    try {
      const nested = JSON.parse(message) as {
        error?: { message?: string; status?: string };
      };
      if (nested?.error?.message) {
        detail = nested.error.message;
      }
    } catch {
      // message is not JSON
    }

    if (
      detail.includes('has not been used') ||
      detail.includes('SERVICE_DISABLED') ||
      detail.includes('it is disabled')
    ) {
      return 'Google Analytics Data API is disabled for this GCP project. Enable it in Google Cloud Console, wait a few minutes, then retry.';
    }
    if (
      detail.includes('PERMISSION_DENIED') ||
      detail.includes('permission')
    ) {
      return 'GA4 permission denied. Ensure the service account is a Viewer on this property.';
    }
    if (detail.includes('limited to 10 metrics')) {
      return 'GA4 metric limit exceeded. Please retry after redeploy.';
    }
    if (
      detail.includes('INVALID_ARGUMENT') ||
      message.includes('INVALID_ARGUMENT')
    ) {
      return `Invalid GA4 request: ${detail.slice(0, 180)}`;
    }
    return detail ? detail.slice(0, 240) : fallback;
  }
}
