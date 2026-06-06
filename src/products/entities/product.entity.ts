import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  ManyToMany,
  OneToMany,
  OneToOne,
  JoinTable,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  JoinColumn,
  BeforeInsert,
  Index,
  ValueTransformer,
} from 'typeorm';
import { Category } from '../../categories/entities/category.entity';
import { Vendor } from '../../vendors/entities/vendor.entity';
import { Brand } from '../../brands/entities/brand.entity';
import { User } from '../../users/entities/user.entity';
import { Media } from '../../media/entities/media.entity';
import { ProductAttribute } from './product-attribute.entity';
import { ProductCategory } from './product-category.entity';
import { ProductMedia } from './product-media.entity';
import { ProductInputJson } from './product-input-json.entity';
import { ProductSpecificationValue } from './product-specification-value.entity';
import { GroupProduct } from './group-product.entity';

const decimalNumberTransformer: ValueTransformer = {
  to(value: number | null | undefined) {
    if (value === null || value === undefined) {
      return value;
    }

    return typeof value === 'number' ? value : Number(value);
  },
  from(value: string | number | null | undefined) {
    if (value === null || value === undefined) {
      return value;
    }

    return typeof value === 'number' ? value : Number(value);
  },
};

export enum ProductStatus {
  ACTIVE = 'active',
  ARCHIVED = 'archived',
  UPDATED = 'updated',
  REVIEW = 'review',
}

export enum ProductWeightUnit {
  GRAM = 'g',
  KILOGRAM = 'kg',
}

export enum ProductDimensionUnit {
  MILLIMETER = 'mm',
  CENTIMETER = 'cm',
  METER = 'm',
}

@Entity('products')
@Index('idx_products_category_id', ['category_id'])
@Index('idx_products_vendor_id', ['vendor_id'])
@Index('idx_products_original_vendor_category_id', ['original_vendor_category_id'])
@Index('idx_products_brand_id', ['brand_id'])
@Index('idx_products_status', ['status'])
@Index('idx_products_visible', ['visible'])
@Index('idx_products_status_visible', ['status', 'visible'])
@Index('idx_products_status_visible_created_at', [
  'status',
  'visible',
  'created_at',
])
@Index('idx_products_status_visible_average_rating', [
  'status',
  'visible',
  'average_rating',
])
@Index('idx_products_sku', ['sku'])
@Index('idx_products_status_category', ['status', 'category_id'])
@Index('idx_products_created_at', ['created_at'])
export class Product {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Column()
  name_en: string;

  @Column({ nullable: true })
  slug: string;
  @Column({ type: 'text', nullable: true })
  record: string | null;
  @Column()
  name_ar: string;

  @Column({ unique: true })
  sku: string;

  @Column('text')
  short_description_en: string;

  @Column('text')
  short_description_ar: string;

  @Column('text')
  long_description_en: string;

  @Column('text')
  long_description_ar: string;

  @Column({ type: 'text', nullable: true })
  reference_link: string | null;

  @Column({
    type: 'enum',
    enum: ProductStatus,
    default: ProductStatus.ACTIVE,
  })
  status: ProductStatus;

  @Column({ default: true })
  visible: boolean;

  // Multiple categories relationship (via junction table)
  @OneToMany(() => ProductCategory, (pc) => pc.product, { cascade: true })
  productCategories: ProductCategory[];

  // Keep category_id for backward compatibility (primary category)
  @ManyToOne(() => Category, { nullable: true })
  @JoinColumn({ name: 'category_id' })
  category: Category;

  @Column({ type: 'int', nullable: true })
  category_id: number | null;

  // Vendor relationship
  @ManyToOne(() => Vendor, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'vendor_id' })
  vendor: Vendor;

  @Column({ nullable: true })
  vendor_id: number;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  original_vendor_categories: Array<{ id?: number; name?: string }>;

  @Column({ type: 'int', nullable: true })
  original_vendor_category_id: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  original_vendor_category_name: string | null;

  // Brand relationship
  @ManyToOne(() => Brand, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'brand_id' })
  brand: Brand;

  @Column({ nullable: true })
  brand_id: number;

  // Product-specific media ownership now lives in the join table.
  @OneToMany(() => ProductMedia, (productMedia) => productMedia.product, {
    cascade: true,
  })
  productMedia: ProductMedia[];

  media?: Array<Media & { is_primary: boolean; sort_order: number }>;

  // ── Pricing (flat) ────────────────────────────────────────────
  @Column('decimal', {
    precision: 10,
    scale: 2,
    default: 0,
    transformer: decimalNumberTransformer,
  })
  cost: number;

  @Column('decimal', {
    precision: 10,
    scale: 2,
    default: 0,
    transformer: decimalNumberTransformer,
  })
  price: number;

  @Column('decimal', {
    precision: 10,
    scale: 2,
    nullable: true,
    transformer: decimalNumberTransformer,
  })
  sale_price: number | null;

  @Column('decimal', {
    precision: 10,
    scale: 2,
    nullable: true,
    transformer: decimalNumberTransformer,
  })
  original_vendor_price: number | null;

  @Column('decimal', {
    precision: 10,
    scale: 2,
    nullable: true,
    transformer: decimalNumberTransformer,
  })
  original_vendor_sale_price: number | null;

  // ── Weight / dimensions (flat) ────────────────────────────────
  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  weight: number | null;

  @Column({
    type: 'varchar',
    length: 10,
    default: ProductWeightUnit.KILOGRAM,
  })
  weight_unit: ProductWeightUnit;

  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  length: number | null;

  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  width: number | null;

  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  height: number | null;

  @Column({
    type: 'varchar',
    length: 10,
    default: ProductDimensionUnit.CENTIMETER,
  })
  dimension_unit: ProductDimensionUnit;

  // ── Stock (flat) ──────────────────────────────────────────────
  @Column({ type: 'int', default: 0 })
  quantity: number;

  @Column({ type: 'int', default: 10 })
  low_stock_threshold: number;

  @Column({ type: 'boolean', default: true })
  is_out_of_stock: boolean;

  // Product attributes relationship
  @OneToMany(() => ProductAttribute, (attr) => attr.product, { cascade: true })
  attributes: ProductAttribute[];

  // Product specifications relationship
  @OneToMany(() => ProductSpecificationValue, (spec) => spec.product, { cascade: true })
  specifications: ProductSpecificationValue[];

  @OneToMany(() => GroupProduct, (groupProduct) => groupProduct.product)
  groupProducts: GroupProduct[];

  @OneToOne(
    () => ProductInputJson,
    (productInputJson) => productInputJson.product,
  )
  product_input_json?: ProductInputJson | null;

  // Tags relationship (many-to-many, drives search term expansion)
  @ManyToMany('Tag', (tag: any) => tag.products, { eager: false })
  @JoinTable({
    name: 'product_tags',
    joinColumn: { name: 'product_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'tag_id', referencedColumnName: 'id' },
  })
  tags: any[];

  // Ratings relationship
  @OneToMany('Rating', 'product')
  ratings: any[];

  @Column('decimal', { precision: 3, scale: 2, default: 0 })
  average_rating: number;

  @Column({ default: 0 })
  total_ratings: number;

  @Column({ nullable: true, type: 'timestamp' })
  archived_at: Date | null;

  @Column({ nullable: true, type: 'int' })
  archived_by: number | null;

  @Column({ nullable: true, type: 'int' })
  created_by: number | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'created_by' })
  createdByUser: User;

  // ── SEO ────────────────────────────────────────────────────────
  @Column({ type: 'varchar', length: 70, nullable: true })
  meta_title_en: string | null;

  @Column({ type: 'varchar', length: 70, nullable: true })
  meta_title_ar: string | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  meta_description_en: string | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  meta_description_ar: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @DeleteDateColumn()
  deleted_at: Date;

  @BeforeInsert()
  generateSku() {
    if (!this.sku) {
      const timestamp = Date.now().toString().slice(-8);
      const random = Math.random().toString(36).substring(2, 6).toUpperCase();
      this.sku = `PRD-${timestamp}-${random}`;
    }
  }
}
