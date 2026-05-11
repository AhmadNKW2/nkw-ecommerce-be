import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager, QueryRunner } from 'typeorm';
import { Wallet } from './entities/wallet.entity';
import { CashbackRule, CashbackType } from './entities/cashback-rule.entity';
import { CreateCashbackRuleDto } from './dto/create-cashback-rule.dto';
import { UpdateCashbackRuleDto } from './dto/update-cashback-rule.dto';
import {
  WalletTransaction,
  TransactionType,
  TransactionSource,
} from './entities/wallet-transaction.entity';
import { AddFundsDto } from './dto/add-funds.dto';
import { FilterTransactionDto } from './dto/filter-transaction.dto';

@Injectable()
export class WalletService {
  constructor(
    @InjectRepository(Wallet)
    private walletRepository: Repository<Wallet>,
    @InjectRepository(WalletTransaction)
    private transactionRepository: Repository<WalletTransaction>,
    @InjectRepository(CashbackRule)
    private cashbackRuleRepository: Repository<CashbackRule>,
    private dataSource: DataSource,
  ) {}

  async getOrCreateWallet(userId: number): Promise<Wallet> {
    let wallet = await this.walletRepository.findOne({
      where: { userId },
    });

    if (!wallet) {
      wallet = this.walletRepository.create({
        userId,
        balance: 0,
        totalCashback: 0,
      });
      wallet = await this.walletRepository.save(wallet);
    }

    return wallet;
  }

  async getWallet(userId: number) {
    const wallet = await this.getOrCreateWallet(userId);

    return {
      data: wallet,
      message: 'Wallet retrieved successfully',
    };
  }

  async addFunds(
    userId: number,
    addFundsDto: AddFundsDto,
    manager?: EntityManager,
  ) {
    let queryRunner: QueryRunner | null = null;
    let transactionalManager: EntityManager;

    if (manager) {
      transactionalManager = manager;
    } else {
      queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();
      transactionalManager = queryRunner.manager;
    }

    try {
      let wallet = await transactionalManager.findOne(Wallet, {
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!wallet) {
        wallet = transactionalManager.create(Wallet, {
          userId,
          balance: 0,
          totalCashback: 0,
        });
        wallet = await transactionalManager.save(Wallet, wallet);
      }

      const newBalance = Number(wallet.balance) + Number(addFundsDto.amount);
      wallet.balance = newBalance;

      if (addFundsDto.source === TransactionSource.CASHBACK) {
        wallet.totalCashback =
          Number(wallet.totalCashback) + Number(addFundsDto.amount);
      }

      await transactionalManager.save(wallet);

      const transaction = transactionalManager.create(WalletTransaction, {
        walletId: wallet.id,
        type: TransactionType.CREDIT,
        source: addFundsDto.source,
        amount: addFundsDto.amount,
        balanceAfter: newBalance,
        description: addFundsDto.description,
        referenceId: addFundsDto.referenceId,
      });

      await transactionalManager.save(transaction);

      if (queryRunner) {
        await queryRunner.commitTransaction();
      }

      return {
        data: { wallet, transaction },
        message: 'Funds added successfully',
      };
    } catch (error) {
      if (queryRunner) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    } finally {
      if (queryRunner) {
        await queryRunner.release();
      }
    }
  }

  async deductFunds(
    userId: number,
    amount: number,
    source: TransactionSource,
    description?: string,
    referenceId?: string,
    manager?: EntityManager,
  ) {
    let queryRunner: QueryRunner | null = null;
    let transactionalManager: EntityManager;

    if (manager) {
      transactionalManager = manager;
    } else {
      queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();
      transactionalManager = queryRunner.manager;
    }

    try {
      const wallet = await transactionalManager.findOne(Wallet, {
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!wallet) {
        throw new NotFoundException('Wallet not found');
      }

      if (Number(wallet.balance) < amount) {
        throw new BadRequestException('Insufficient wallet balance');
      }

      const newBalance = Number(wallet.balance) - amount;
      wallet.balance = newBalance;
      await transactionalManager.save(wallet);

      const transaction = transactionalManager.create(WalletTransaction, {
        walletId: wallet.id,
        type: TransactionType.DEBIT,
        source,
        amount,
        balanceAfter: newBalance,
        description,
        referenceId,
      });

      await transactionalManager.save(transaction);

      if (queryRunner) {
        await queryRunner.commitTransaction();
      }

      return {
        data: { wallet, transaction },
        message: 'Funds deducted successfully',
      };
    } catch (error) {
      if (queryRunner) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    } finally {
      if (queryRunner) {
        await queryRunner.release();
      }
    }
  }

  async getTransactions(userId: number, filterDto: FilterTransactionDto) {
    const {
      page = 1,
      limit = 10,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
      type,
      source,
      minAmount,
      maxAmount,
    } = filterDto;

    const wallet = await this.getOrCreateWallet(userId);

    const queryBuilder = this.transactionRepository
      .createQueryBuilder('transaction')
      .where('transaction.walletId = :walletId', { walletId: wallet.id });

    if (type) {
      queryBuilder.andWhere('transaction.type = :type', { type });
    }

    if (source) {
      queryBuilder.andWhere('transaction.source = :source', { source });
    }

    if (minAmount !== undefined) {
      queryBuilder.andWhere('transaction.amount >= :minAmount', { minAmount });
    }

    if (maxAmount !== undefined) {
      queryBuilder.andWhere('transaction.amount <= :maxAmount', { maxAmount });
    }

    queryBuilder
      .orderBy(`transaction.${sortBy}`, sortOrder)
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await queryBuilder.getManyAndCount();

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
      message: 'Transactions retrieved successfully',
    };
  }

  // --- Cashback Rules Management ---

  async createCashbackRule(dto: CreateCashbackRuleDto) {
    const rule = this.cashbackRuleRepository.create(dto);
    return this.cashbackRuleRepository.save(rule);
  }

  async findAllCashbackRules() {
    return this.cashbackRuleRepository.find({
      order: { createdAt: 'DESC' },
    });
  }

  async updateCashbackRule(id: number, dto: UpdateCashbackRuleDto) {
    const rule = await this.cashbackRuleRepository.findOne({ where: { id } });
    if (!rule) {
      throw new NotFoundException('Cashback rule not found');
    }
    Object.assign(rule, dto);
    return this.cashbackRuleRepository.save(rule);
  }

  async deleteCashbackRule(id: number) {
    const result = await this.cashbackRuleRepository.delete(id);
    if (result.affected === 0) {
      throw new NotFoundException('Cashback rule not found');
    }
    return { message: 'Cashback rule deleted successfully' };
  }

  async calculateCashback(orderAmount: number): Promise<number> {
    return this.calculateCashbackWithManager(orderAmount);
  }

  private async calculateCashbackWithManager(
    orderAmount: number,
    manager?: EntityManager,
  ): Promise<number> {
    const activeRules = await (manager
      ? manager.find(CashbackRule, { where: { isActive: true } })
      : this.cashbackRuleRepository.find({
      where: { isActive: true },
      }));

    let bestCashback = 0;

    for (const rule of activeRules) {
      // Check minimum order amount
      const minOrderAmount = Number(rule.minOrderAmount ?? 0);
      const ruleValue = Number(rule.value ?? 0);
      const maxCashbackAmount =
        rule.maxCashbackAmount !== null && rule.maxCashbackAmount !== undefined
          ? Number(rule.maxCashbackAmount)
          : null;

      if (minOrderAmount > 0 && orderAmount < minOrderAmount) {
        continue;
      }

      let currentCashback = 0;

      if (rule.type === CashbackType.FIXED) {
        currentCashback = ruleValue;
      } else if (rule.type === CashbackType.PERCENTAGE) {
        currentCashback = (orderAmount * ruleValue) / 100;
      }

      // Apply Max Cap
      if (maxCashbackAmount !== null && currentCashback > maxCashbackAmount) {
        currentCashback = maxCashbackAmount;
      }

      // Keep the best offer for the customer
      if (currentCashback > bestCashback) {
        bestCashback = currentCashback;
      }
    }

    return bestCashback;
  }

  async applyCashback(
    userId: number,
    orderAmount: number,
    orderId: string,
    manager?: EntityManager,
  ) {
    const existingCashbackTransaction = manager
      ? await manager.findOne(WalletTransaction, {
          where: {
            source: TransactionSource.CASHBACK,
            referenceId: orderId,
          },
        })
      : await this.transactionRepository.findOne({
          where: {
            source: TransactionSource.CASHBACK,
            referenceId: orderId,
          },
        });

    if (existingCashbackTransaction) {
      return { message: 'Cashback already applied' };
    }

    const cashbackAmount = await this.calculateCashbackWithManager(
      orderAmount,
      manager,
    );

    if (cashbackAmount <= 0) {
      return { message: 'No cashback applicable' };
    }

    return await this.addFunds(userId, {
      amount: cashbackAmount,
      source: TransactionSource.CASHBACK,
      description: `Cashback for order #${orderId}`,
      referenceId: orderId,
    }, manager);
  }
}
