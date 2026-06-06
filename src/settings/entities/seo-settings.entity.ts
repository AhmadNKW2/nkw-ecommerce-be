import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('seo_settings')
export class SeoSettings {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Column({ type: 'varchar', length: 120, default: 'ordonsooq' })
  site_name_en: string;

  @Column({ type: 'varchar', length: 120, default: 'ordonsooq' })
  site_name_ar: string;

  @Column({ type: 'varchar', length: 70, default: 'ordonsooq' })
  default_meta_title_en: string;

  @Column({ type: 'varchar', length: 70, default: 'ordonsooq' })
  default_meta_title_ar: string;

  @Column({
    type: 'varchar',
    length: 160,
    default:
      'Your premier destination for online shopping - Quality products, great prices, fast delivery',
  })
  default_meta_description_en: string;

  @Column({
    type: 'varchar',
    length: 160,
    default:
      'وجهتك المميزة للتسوق الإلكتروني - منتجات عالية الجودة وأسعار رائعة وتوصيل سريع',
  })
  default_meta_description_ar: string;

  @Column({ type: 'varchar', length: 2048, nullable: true })
  default_og_image: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  twitter_handle: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  google_verification: string | null;

  @Column({ type: 'boolean', default: true })
  robots_index: boolean;

  @Column({ type: 'boolean', default: true })
  robots_follow: boolean;

  @Column({ type: 'boolean', default: true })
  show_sale_pricing: boolean;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}