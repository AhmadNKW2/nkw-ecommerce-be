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
  attributes_enabled: boolean;

  @Column({ type: 'boolean', default: true })
  specifications_enabled: boolean;

  @Column({ type: 'boolean', default: true })
  weight_and_dimensions_enabled: boolean;

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
