import { Injectable, MessageEvent } from '@nestjs/common';
import { Observable, Subject, interval, merge } from 'rxjs';
import { map } from 'rxjs/operators';

export type AdminNotificationPayload = {
  type:
    | 'order.created'
    | 'note.created'
    | 'submission.created'
    | 'catalog_request.created'
    | 'partner.created';
  entityId: number;
  createdAt: string;
};

@Injectable()
export class AdminNotificationsService {
  private readonly events$ = new Subject<AdminNotificationPayload>();

  stream(): Observable<MessageEvent> {
    const heartbeat$ = interval(25000).pipe(
      map(() => ({
        type: 'heartbeat',
        data: { ok: true, ts: new Date().toISOString() },
      })),
    );

    const notifications$ = this.events$.pipe(
      map((payload) => ({
        type: 'notification',
        data: payload,
      })),
    );

    return merge(heartbeat$, notifications$);
  }

  publishOrderCreated(orderId: number): void {
    this.events$.next({
      type: 'order.created',
      entityId: orderId,
      createdAt: new Date().toISOString(),
    });
  }

  publishNoteCreated(noteId: number): void {
    this.events$.next({
      type: 'note.created',
      entityId: noteId,
      createdAt: new Date().toISOString(),
    });
  }

  publishSubmissionCreated(submissionId: number): void {
    this.events$.next({
      type: 'submission.created',
      entityId: submissionId,
      createdAt: new Date().toISOString(),
    });
  }

  publishCatalogRequestCreated(requestId: number): void {
    this.events$.next({
      type: 'catalog_request.created',
      entityId: requestId,
      createdAt: new Date().toISOString(),
    });
  }

  publishPartnerCreated(partnerId: number): void {
    this.events$.next({
      type: 'partner.created',
      entityId: partnerId,
      createdAt: new Date().toISOString(),
    });
  }
}
