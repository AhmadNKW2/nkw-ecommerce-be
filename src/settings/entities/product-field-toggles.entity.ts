import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('product_field_toggles')
export class ProductFieldToggles {
  @PrimaryGeneratedColumn('increment')
  id: number;

  // Disabling toggles — enforced by BE product service on create/update.
  @Column({ type: 'boolean', default: true })
  vendors_enabled: boolean;

  @Column({ type: 'boolean', default: true })
  ratings_enabled: boolean;

  @Column({ type: 'boolean', default: true })
  attributes_enabled: boolean;

  @Column({ type: 'boolean', default: true })
  specifications_enabled: boolean;

  @Column({ type: 'boolean', default: true })
  weight_and_dimensions_enabled: boolean;

  @Column({ type: 'boolean', default: true })
  partners_enabled: boolean;

  @Column({ type: 'boolean', default: true })
  cashback_enabled: boolean;

  @Column({ type: 'boolean', default: true })
  banners_enabled: boolean;

  @Column({ type: 'boolean', default: true })
  import_ai_products_enabled: boolean;

  @Column({ type: 'boolean', default: true })
  linked_products_enabled: boolean;

  @Column({ type: 'boolean', default: true })
  reference_links_enabled: boolean;

  @Column({ type: 'boolean', default: true })
  product_status_enabled: boolean;

  @Column({ type: 'boolean', default: true })
  pricing_view_enabled: boolean;

  @Column({ type: 'boolean', default: false })
  easy_purchase_enabled: boolean;

  @Column({ type: 'boolean', default: true })
  cart_sidebar_button_enabled: boolean;

  @Column({ type: 'boolean', default: true })
  popup_enabled: boolean;

  // Appearance-only toggles — admin dashboard UI only; BE ignores them.
  @Column({ type: 'boolean', default: true })
  reference_link_visible_admin: boolean;

  @Column({ type: 'boolean', default: true })
  meta_title_visible_admin: boolean;

  @Column({ type: 'boolean', default: true })
  meta_description_visible_admin: boolean;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
