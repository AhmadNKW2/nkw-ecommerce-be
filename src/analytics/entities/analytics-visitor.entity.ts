import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { AnalyticsSession } from './analytics-session.entity';
import { AnalyticsEvent } from './analytics-event.entity';

@Entity('analytics_visitors')
export class AnalyticsVisitor {
  @PrimaryGeneratedColumn()
  id: number;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  browser_key: string;

  @Column({ type: 'int', nullable: true })
  user_id: number | null;

  @Column({ type: 'text', nullable: true })
  user_agent: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  last_path: string | null;

  @Column({ type: 'int', default: 0 })
  event_count: number;

  @Column({ type: 'int', default: 0 })
  session_count: number;

  @Column({ type: 'timestamptz' })
  first_seen_at: Date;

  @Column({ type: 'timestamptz' })
  last_seen_at: Date;

  @OneToMany(() => AnalyticsSession, (session) => session.visitor)
  sessions: AnalyticsSession[];

  @OneToMany(() => AnalyticsEvent, (event) => event.visitor)
  events: AnalyticsEvent[];

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
