import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('site_popup_settings')
export class SitePopupSettings {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Column({ type: 'boolean', default: false })
  enabled: boolean;

  @Column({ type: 'varchar', length: 2048, nullable: true })
  image_url: string | null;

  @Column({ type: 'varchar', length: 2048, nullable: true })
  link_url: string | null;

  @Column({ type: 'int', default: 8 })
  dismiss_after_seconds: number;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
