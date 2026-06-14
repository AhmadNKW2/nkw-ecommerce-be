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

  @Column({ type: 'varchar', length: 120, default: 'Storefront' })
  site_name_en: string;

  @Column({ type: 'varchar', length: 120, default: 'المتجر الإلكتروني' })
  site_name_ar: string;

  @Column({ type: 'varchar', length: 70, default: 'Storefront' })
  default_meta_title_en: string;

  @Column({ type: 'varchar', length: 70, default: 'المتجر الإلكتروني' })
  default_meta_title_ar: string;

  @Column({
    type: 'varchar',
    length: 160,
    default:
      'A modern online shopping destination with quality products, fair prices, and reliable delivery.',
  })
  default_meta_description_en: string;

  @Column({
    type: 'varchar',
    length: 160,
    default:
      'وجهة تسوق إلكترونية حديثة بمنتجات مميزة وأسعار مناسبة وتوصيل موثوق.',
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

  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    default: 50.0,
    transformer: {
      to: (value: number) => value,
      from: (value: string) => parseFloat(value) || 0,
    },
  })
  free_delivery_amount: number;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}