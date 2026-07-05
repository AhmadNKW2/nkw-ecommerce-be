import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { Order, OrderStatus } from './order.entity';

@Entity('order_status_history')
@Index('idx_order_status_history_order_id', ['orderId'])
export class OrderStatusHistory {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @ManyToOne(() => Order, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'orderId' })
  order: Order;

  @Column()
  orderId: number;

  @Column({ type: 'varchar', length: 30 })
  status: OrderStatus;

  @Column({ nullable: true })
  note: string;

  @Column({ nullable: true })
  changedBy: string; // e.g. "admin" or "system"

  @CreateDateColumn()
  createdAt: Date;
}
