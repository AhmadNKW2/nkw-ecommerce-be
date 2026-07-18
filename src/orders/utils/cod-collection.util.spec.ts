import { CodCollectionStatus, PaymentMethod } from '../entities/order.entity';
import {
  calculateCodAmountDue,
  clearUncollectedCod,
  resolveCodCollection,
} from './cod-collection.util';

describe('cod-collection.util', () => {
  it('calculates cash due after wallet', () => {
    expect(calculateCodAmountDue(50, 10)).toBe(40);
    expect(calculateCodAmountDue(50, 50)).toBe(0);
  });

  it('marks COD orders as pending with amount due', () => {
    expect(
      resolveCodCollection({
        paymentMethod: PaymentMethod.COD,
        totalAmount: 25,
        walletAppliedAmount: 5,
      }),
    ).toEqual({
      codCollectionStatus: CodCollectionStatus.PENDING,
      codAmountDue: 20,
      codCollectedAt: null,
    });
  });

  it('skips non-COD and fully-wallet orders', () => {
    expect(
      resolveCodCollection({
        paymentMethod: PaymentMethod.CARD,
        totalAmount: 25,
      }).codCollectionStatus,
    ).toBeNull();

    expect(
      resolveCodCollection({
        paymentMethod: PaymentMethod.COD,
        totalAmount: 25,
        walletAppliedAmount: 25,
      }).codCollectionStatus,
    ).toBeNull();
  });

  it('clears uncollected COD on cancel', () => {
    expect(clearUncollectedCod(CodCollectionStatus.PENDING)).toEqual({
      codCollectionStatus: null,
      codAmountDue: 0,
      codCollectedAt: null,
    });
    expect(clearUncollectedCod(CodCollectionStatus.RECEIVED)).toBeNull();
  });
});
