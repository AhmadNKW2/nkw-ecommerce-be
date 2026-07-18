import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  OneToMany,
  CreateDateColumn,
  UpdateDateColumn,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Coupon } from '../../coupons/entities/coupon.entity';
import { OrderItem } from './order-item.entity';
import { OrderStatusHistory } from './order-status-history.entity';

export enum OrderStatus {
  PENDING = 'pending',
  DELIVERED = 'delivered',
  CANCELLED = 'cancelled',
  REFUNDED = 'refunded',
}

export enum PaymentMethod {
  CARD = 'card',
  COD = 'cod',
  WALLET = 'wallet',
}

/** Cash remittance from the shipping company for COD orders. */
export enum CodCollectionStatus {
  PENDING = 'pending',
  RECEIVED = 'received',
}

@Entity('orders')
@Index('idx_orders_user_id', ['userId'])
@Index('idx_orders_status', ['status'])
@Index('idx_orders_created_at', ['createdAt'])
export class Order {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ nullable: true })
  userId: number | null;

  @OneToMany(() => OrderItem, (item) => item.order, { cascade: true })
  items: OrderItem[];

  @OneToMany(() => OrderStatusHistory, (history) => history.order, { cascade: true })
  statusHistory: OrderStatusHistory[];

  @Column({
    type: 'enum',
    enum: OrderStatus,
    default: OrderStatus.PENDING,
  })
  status: OrderStatus;

  @Column('decimal', { precision: 10, scale: 2 })
  subtotalAmount: number;

  @Column('decimal', { precision: 10, scale: 2, default: 0 })
  taxAmount: number;

  @Column('decimal', { precision: 10, scale: 2, default: 0 })
  shippingAmount: number;

  @Column('decimal', { precision: 10, scale: 2, default: 0 })
  discountAmount: number;

  @Column('decimal', { precision: 10, scale: 2 })
  totalAmount: number;

  @ManyToOne(() => Coupon, { nullable: true })
  @JoinColumn({ name: 'couponId' })
  coupon: Coupon;

  @Column({ type: 'int', nullable: true })
  couponId: number | null;

  @Column('jsonb', { nullable: true })
  shippingAddress: any;

  @Column('jsonb', { nullable: true })
  billingAddress: any;

  @Column({
    type: 'enum',
    enum: PaymentMethod,
  })
  paymentMethod: PaymentMethod;

  @Column('decimal', { precision: 10, scale: 2, default: 0 })
  walletAppliedAmount: number;

  /**
   * Shipping-company remittance for COD cash.
   * Null when the order is not COD (or no cash remains after wallet).
   */
  @Column({ type: 'varchar', length: 30, nullable: true })
  codCollectionStatus: CodCollectionStatus | null;

  /** Cash amount the shipping company owes you for this COD order. */
  @Column('decimal', { precision: 10, scale: 2, default: 0 })
  codAmountDue: number;

  /** When you marked cash as received from the shipping company. */
  @Column({ type: 'timestamp', nullable: true })
  codCollectedAt: Date | null;

  @Column({ nullable: true })
  notes: string;

  @Column({ nullable: true })
  trackingNumber: string;

  /** Storefront analytics client id (`ordonsooq_browser_key`). */
  @Index('idx_orders_browser_key')
  @Column({ name: 'browser_key', type: 'varchar', length: 64, nullable: true })
  browserKey: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
