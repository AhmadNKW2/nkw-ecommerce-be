import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('admin_client_devices')
export class AdminClientDevice {
  @PrimaryGeneratedColumn()
  id: number;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  browser_key: string;

  @Index()
  @Column({ type: 'int' })
  admin_user_id: number;

  @Column({ type: 'varchar', length: 32, default: 'admin_fe' })
  source: string;

  /** Admin-chosen label, e.g. "Office Chrome" / "Home laptop". */
  @Column({ type: 'varchar', length: 120, nullable: true })
  device_name: string | null;

  /** Parsed from user agent: Desktop | Mobile | Tablet | Unknown */
  @Column({ type: 'varchar', length: 32, nullable: true })
  device_type: string | null;

  /** Specific model when known, e.g. "Galaxy S24 Ultra" or "SM-S928B". */
  @Column({ type: 'varchar', length: 120, nullable: true })
  device_model: string | null;

  @Column({ type: 'text', nullable: true })
  user_agent: string | null;

  @Column({ type: 'timestamptz' })
  first_seen_at: Date;

  @Column({ type: 'timestamptz' })
  last_seen_at: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
