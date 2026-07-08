import { SeoSettings } from './entities/seo-settings.entity';

const DEFAULT_DELIVERY_FEE = 2;
const DEFAULT_FREE_DELIVERY_AMOUNT = 50;

export function resolveDeliveryFee(settings?: Pick<SeoSettings, 'delivery_fee'> | null): number {
  const fee = settings?.delivery_fee;
  if (fee !== undefined && fee !== null && Number.isFinite(Number(fee))) {
    return Number(fee);
  }
  return DEFAULT_DELIVERY_FEE;
}

export function calculateOrderShippingAmount(
  subtotalAmount: number,
  settings?: Pick<SeoSettings, 'delivery_fee' | 'free_delivery_enabled' | 'free_delivery_amount'> | null,
): number {
  const freeDeliveryEnabled = settings?.free_delivery_enabled !== false;
  const freeDeliveryAmount = settings?.free_delivery_amount ?? DEFAULT_FREE_DELIVERY_AMOUNT;

  if (freeDeliveryEnabled && subtotalAmount >= freeDeliveryAmount) {
    return 0;
  }

  return resolveDeliveryFee(settings);
}
