import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { AnalyticsVisitor } from './analytics-visitor.entity';
import { AnalyticsEvent } from './analytics-event.entity';

@Entity('analytics_sessions')
@Index(['visitor_id', 'session_key'], { unique: true })
export class AnalyticsSession {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  visitor_id: number;

  @ManyToOne(() => AnalyticsVisitor, (visitor) => visitor.sessions, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'visitor_id' })
  visitor: AnalyticsVisitor;

  @Column({ type: 'varchar', length: 64 })
  session_key: string;

  @Column({ type: 'varchar', length: 512, nullable: true })
  landing_path: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  exit_path: string | null;

  @Column({ type: 'int', default: 0 })
  event_count: number;

  @Column({ type: 'int', default: 0 })
  page_view_count: number;

  @Column({ type: 'int', default: 0 })
  duration_seconds: number;

  @Column({ type: 'timestamptz' })
  started_at: Date;

  @Column({ type: 'timestamptz' })
  last_seen_at: Date;

  @OneToMany(() => AnalyticsEvent, (event) => event.session)
  events: AnalyticsEvent[];

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
