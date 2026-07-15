import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { ShippingDeliveryRule } from '../shipping-delivery-rule';

@Entity('seo_settings')
export class SeoSettings {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Column({ type: 'varchar', length: 120, default: 'Storefront' })
  site_name_en: string;

  @Column({ type: 'varchar', length: 120, default: 'المتجر الإلكتروني' })
  site_name_ar: string;

  @Column({ type: 'varchar', length: 2048, nullable: true })
  site_logo: string | null;

  @Column({ type: 'varchar', length: 7, nullable: true })
  brand_primary: string | null;

  @Column({ type: 'varchar', length: 7, nullable: true })
  brand_primary_2: string | null;

  @Column({ type: 'varchar', length: 7, nullable: true })
  brand_primary_3: string | null;

  @Column({ type: 'varchar', length: 7, nullable: true })
  brand_secondary: string | null;

  @Column({ type: 'varchar', length: 7, nullable: true })
  brand_success: string | null;

  @Column({ type: 'varchar', length: 7, nullable: true })
  brand_success_2: string | null;

  @Column({ type: 'varchar', length: 7, nullable: true })
  brand_danger: string | null;

  @Column({ type: 'varchar', length: 7, nullable: true })
  brand_danger_2: string | null;

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

  @Column({ type: 'varchar', length: 255, default: 'help@ordonsooq.com' })
  support_email: string;

  @Column({ type: 'varchar', length: 2048, nullable: true })
  facebook_url: string | null;

  @Column({ type: 'varchar', length: 2048, nullable: true })
  twitter_url: string | null;

  @Column({ type: 'varchar', length: 2048, nullable: true })
  instagram_url: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  google_verification: string | null;

  @Column({ type: 'boolean', default: true })
  robots_index: boolean;

  @Column({ type: 'boolean', default: true })
  robots_follow: boolean;

  @Column({ type: 'boolean', default: true })
  show_sale_pricing: boolean;

  @Column({ type: 'boolean', default: true })
  free_delivery_enabled: boolean;

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

  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    default: 2.0,
    transformer: {
      to: (value: number) => value,
      from: (value: string) => parseFloat(value) || 0,
    },
  })
  delivery_fee: number;

  @Column({ type: 'int', default: 10 })
  low_stock_threshold: number;

  @Column({ type: 'boolean', default: false })
  shipping_rules_enabled: boolean;

  @Column({ type: 'int', default: 14 })
  shipping_cutoff_hour: number;

  /** Dynamic delivery rules evaluated on the storefront (Amman time). */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  shipping_rules: ShippingDeliveryRule[];

  /** @deprecated Kept for DB compatibility; unused by admin/storefront. */
  @Column({ type: 'varchar', length: 255, default: '', nullable: true })
  shipping_rule_1_when_en: string | null;

  /** @deprecated Kept for DB compatibility; unused by admin/storefront. */
  @Column({ type: 'varchar', length: 255, default: '', nullable: true })
  shipping_rule_1_when_ar: string | null;

  /** @deprecated Kept for DB compatibility; unused by admin/storefront. */
  @Column({ type: 'varchar', length: 255, default: '', nullable: true })
  shipping_rule_1_arrives_en: string | null;

  /** @deprecated Kept for DB compatibility; unused by admin/storefront. */
  @Column({ type: 'varchar', length: 255, default: '', nullable: true })
  shipping_rule_1_arrives_ar: string | null;

  /** @deprecated Kept for DB compatibility; unused by admin/storefront. */
  @Column({ type: 'varchar', length: 255, default: '', nullable: true })
  shipping_rule_2_when_en: string | null;

  /** @deprecated Kept for DB compatibility; unused by admin/storefront. */
  @Column({ type: 'varchar', length: 255, default: '', nullable: true })
  shipping_rule_2_when_ar: string | null;

  /** @deprecated Kept for DB compatibility; unused by admin/storefront. */
  @Column({ type: 'varchar', length: 255, default: '', nullable: true })
  shipping_rule_2_arrives_en: string | null;

  /** @deprecated Kept for DB compatibility; unused by admin/storefront. */
  @Column({ type: 'varchar', length: 255, default: '', nullable: true })
  shipping_rule_2_arrives_ar: string | null;

  /** @deprecated Kept for DB compatibility; unused by admin/storefront. */
  @Column({ type: 'varchar', length: 255, default: '', nullable: true })
  shipping_rule_3_when_en: string | null;

  /** @deprecated Kept for DB compatibility; unused by admin/storefront. */
  @Column({ type: 'varchar', length: 255, default: '', nullable: true })
  shipping_rule_3_when_ar: string | null;

  /** @deprecated Kept for DB compatibility; unused by admin/storefront. */
  @Column({ type: 'varchar', length: 255, default: '', nullable: true })
  shipping_rule_3_arrives_en: string | null;

  /** @deprecated Kept for DB compatibility; unused by admin/storefront. */
  @Column({ type: 'varchar', length: 255, default: '', nullable: true })
  shipping_rule_3_arrives_ar: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}