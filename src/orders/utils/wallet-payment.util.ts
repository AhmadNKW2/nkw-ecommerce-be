import { BadRequestException } from '@nestjs/common';
import { PaymentMethod, PaymentStatus } from '../entities/order.entity';

type ResolveWalletPaymentInput = {
  totalAmount: number;
  paymentMethod: PaymentMethod;
  walletAppliedAmount?: number | null;
};

export type WalletPaymentResolution = {
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  walletAppliedAmount: number;
  remainingCashAmount: number;
};

export function resolveWalletPayment(
  input: ResolveWalletPaymentInput,
): WalletPaymentResolution {
  const requestedWalletAmount =
    input.walletAppliedAmount ??
    (input.paymentMethod === PaymentMethod.WALLET ? input.totalAmount : 0);
  const walletAppliedAmount = Number(requestedWalletAmount);

  if (!Number.isFinite(walletAppliedAmount)) {
    throw new BadRequestException('Wallet amount must be a valid number');
  }

  if (walletAppliedAmount < 0) {
    throw new BadRequestException('Wallet amount cannot be negative');
  }

  if (walletAppliedAmount > input.totalAmount) {
    throw new BadRequestException('Wallet amount cannot exceed order total');
  }

  const remainingCashAmount = Math.max(input.totalAmount - walletAppliedAmount, 0);

  if (
    walletAppliedAmount > 0 &&
    remainingCashAmount > 0 &&
    input.paymentMethod !== PaymentMethod.COD
  ) {
    throw new BadRequestException(
      'Wallet balance can only be combined with cash on delivery',
    );
  }

  const paymentMethod =
    walletAppliedAmount > 0 && remainingCashAmount === 0
      ? PaymentMethod.WALLET
      : input.paymentMethod;

  return {
    paymentMethod,
    paymentStatus:
      paymentMethod === PaymentMethod.WALLET
        ? PaymentStatus.PAID
        : PaymentStatus.PENDING,
    walletAppliedAmount,
    remainingCashAmount,
  };
}