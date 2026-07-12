import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  StreamableFile,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiResponse } from '../interfaces/api-response.interface';

// Matches UTC ISO strings like "2026-03-04T08:42:15.655Z"
const UTC_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const OFFSET_MS = 3 * 60 * 60 * 1000; // UTC+3

function toUtcPlus6(value: unknown): unknown {
  if (typeof value === 'string' && UTC_ISO_RE.test(value)) {
    const shifted = new Date(new Date(value).getTime() + OFFSET_MS);
    return shifted.toISOString().replace('Z', '+03:00');
  }
  if (value instanceof Date) {
    const shifted = new Date(value.getTime() + OFFSET_MS);
    return shifted.toISOString().replace('Z', '+03:00');
  }
  if (Array.isArray(value)) {
    return value.map(toUtcPlus6);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      result[key] = toUtcPlus6((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<
  T,
  ApiResponse<T>
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiResponse<T>> {
    const response = context.switchToHttp().getResponse();
    const request = context.switchToHttp().getRequest();
    const acceptHeader = String(request?.headers?.accept ?? '').toLowerCase();
    const contentTypeHeader = String(
      response?.getHeader?.('content-type') ?? '',
    ).toLowerCase();

    if (
      acceptHeader.includes('text/event-stream') ||
      contentTypeHeader.includes('text/event-stream')
    ) {
      return next.handle() as any;
    }

    const now = toUtcPlus6(new Date()) as string;

    return next.handle().pipe(
      map((data): any => {
        if (data instanceof StreamableFile) {
          return data;
        }

        // If data already has the response structure, return it
        if (data && typeof data === 'object' && 'success' in data) {
          return {
            ...(toUtcPlus6(data) as ApiResponse<T>),
            time: now,
          };
        }

        // Check if data has meta (pagination)
        if (
          data &&
          typeof data === 'object' &&
          'data' in data &&
          'meta' in data
        ) {
          const payload = data as {
            data: unknown;
            meta: unknown;
            facets?: unknown;
            search_time_ms?: number;
            message?: string;
          };

          return {
            success: true,
            data: toUtcPlus6(payload.data),
            meta: toUtcPlus6(payload.meta),
            ...(Array.isArray(payload.facets)
              ? { facets: toUtcPlus6(payload.facets) }
              : {}),
            ...(payload.search_time_ms != null
              ? { search_time_ms: payload.search_time_ms }
              : {}),
            message: payload.message || 'Success',
            time: now,
          };
        }

        // Default response
        return {
          success: true,
          data: toUtcPlus6(data),
          message: 'Success',
          time: now,
        };
      }),
    );
  }
}
