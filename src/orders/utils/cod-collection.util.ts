import { CodCollectionStatus, PaymentMethod } from '../entities/order.entity';

export type CodCollectionResolution = {
  codCollectionStatus: CodCollectionStatus | null;
  codAmountDue: number;
  codCollectedAt: Date | null;
};

/** Cash the shipping company must return for a COD order. */
export function calculateCodAmountDue(
  totalAmount: number,
  walletAppliedAmount: number | null | undefined,
): number {
  const total = Number(totalAmount);
  const wallet = Number(walletAppliedAmount ?? 0);
  if (!Number.isFinite(total) || !Number.isFinite(wallet)) {
    return 0;
  }
  return Math.max(total - wallet, 0);
}

export function resolveCodCollection(input: {
  paymentMethod: PaymentMethod;
  totalAmount: number;
  walletAppliedAmount?: number | null;
}): CodCollectionResolution {
  const codAmountDue = calculateCodAmountDue(
    input.totalAmount,
    input.walletAppliedAmount,
  );
  const isCod =
    input.paymentMethod === PaymentMethod.COD && codAmountDue > 0;

  return {
    codCollectionStatus: isCod ? CodCollectionStatus.PENDING : null,
    codAmountDue: isCod ? codAmountDue : 0,
    codCollectedAt: null,
  };
}

/** Clear COD debt when an order is cancelled/refunded before cash was remitted. */
export function clearUncollectedCod(
  currentStatus: CodCollectionStatus | null | undefined,
): CodCollectionResolution | null {
  if (!currentStatus || currentStatus === CodCollectionStatus.RECEIVED) {
    return null;
  }

  return {
    codCollectionStatus: null,
    codAmountDue: 0,
    codCollectedAt: null,
  };
}
