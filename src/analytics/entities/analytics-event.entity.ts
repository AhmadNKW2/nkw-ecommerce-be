import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { AnalyticsVisitor } from './analytics-visitor.entity';
import { AnalyticsSession } from './analytics-session.entity';

@Entity('analytics_events')
export class AnalyticsEvent {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ type: 'int' })
  visitor_id: number;

  @ManyToOne(() => AnalyticsVisitor, (visitor) => visitor.events, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'visitor_id' })
  visitor: AnalyticsVisitor;

  @Index()
  @Column({ type: 'int' })
  session_id: number;

  @ManyToOne(() => AnalyticsSession, (session) => session.events, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'session_id' })
  session: AnalyticsSession;

  @Index()
  @Column({ type: 'varchar', length: 160 })
  event_name: string;

  @Column({ type: 'varchar', length: 1024, nullable: true })
  path: string | null;

  @Column({ type: 'jsonb', nullable: true })
  properties: Record<string, unknown> | null;

  @Column({ type: 'timestamptz' })
  occurred_at: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
