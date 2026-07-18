import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { Product } from '../../products/entities/product.entity';

export enum BrandStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  ARCHIVED = 'archived',
}

@Entity('brands')
@Index('idx_brands_status', ['status'])
@Index('idx_brands_visible', ['visible'])
@Index('idx_brands_status_visible', ['status', 'visible'])
@Index('idx_brands_sort_order', ['sort_order'])
export class Brand {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Column({ unique: true, nullable: true })
  slug: string;

  @Column({ unique: true })
  name_en: string;

  @Column({ unique: true })
  name_ar: string;

  @Column({ nullable: true })
  description_en?: string;

  @Column({ nullable: true })
  description_ar?: string;

  @Column({ type: 'varchar', length: 70, nullable: true })
  meta_title_en: string | null;

  @Column({ type: 'varchar', length: 70, nullable: true })
  meta_title_ar: string | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  meta_description_en: string | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  meta_description_ar: string | null;

  @Column({ nullable: true })
  logo?: string;

  @Column({
    type: 'enum',
    enum: BrandStatus,
    default: BrandStatus.ACTIVE,
  })
  status: BrandStatus;

  @Column({ default: true })
  visible: boolean;

  @Column({ default: 0 })
  sort_order: number;

  @Column({ nullable: true, type: 'timestamp' })
  archived_at: Date | null;

  @Column({ nullable: true, type: 'int' })
  archived_by: number | null;

  @OneToMany(() => Product, (product) => product.brand)
  products: Product[];

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
