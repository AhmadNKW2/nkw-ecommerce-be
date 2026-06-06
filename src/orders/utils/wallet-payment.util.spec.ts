import { BadRequestException } from '@nestjs/common';
import { PaymentMethod, PaymentStatus } from '../entities/order.entity';
import { resolveWalletPayment } from './wallet-payment.util';

describe('resolveWalletPayment', () => {
  it('keeps legacy full-wallet orders fully paid', () => {
    expect(
      resolveWalletPayment({
        totalAmount: 120,
        paymentMethod: PaymentMethod.WALLET,
      }),
    ).toEqual({
      paymentMethod: PaymentMethod.WALLET,
      paymentStatus: PaymentStatus.PAID,
      walletAppliedAmount: 120,
      remainingCashAmount: 0,
    });
  });

  it('allows partial wallet payments only with cash on delivery', () => {
    expect(
      resolveWalletPayment({
        totalAmount: 120,
        paymentMethod: PaymentMethod.COD,
        walletAppliedAmount: 35,
      }),
    ).toEqual({
      paymentMethod: PaymentMethod.COD,
      paymentStatus: PaymentStatus.PENDING,
      walletAppliedAmount: 35,
      remainingCashAmount: 85,
    });
  });

  it('normalizes full COD plus wallet coverage into a wallet-paid order', () => {
    expect(
      resolveWalletPayment({
        totalAmount: 120,
        paymentMethod: PaymentMethod.COD,
        walletAppliedAmount: 120,
      }),
    ).toEqual({
      paymentMethod: PaymentMethod.WALLET,
      paymentStatus: PaymentStatus.PAID,
      walletAppliedAmount: 120,
      remainingCashAmount: 0,
    });
  });

  it('rejects wallet amounts above the order total', () => {
    expect(() =>
      resolveWalletPayment({
        totalAmount: 120,
        paymentMethod: PaymentMethod.COD,
        walletAppliedAmount: 121,
      }),
    ).toThrow(BadRequestException);
  });

  it('rejects mixed wallet payments for non-COD methods', () => {
    expect(() =>
      resolveWalletPayment({
        totalAmount: 120,
        paymentMethod: PaymentMethod.CARD,
        walletAppliedAmount: 20,
      }),
    ).toThrow('Wallet balance can only be combined with cash on delivery');
  });
});