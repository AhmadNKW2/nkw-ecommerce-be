/** Weekday: 0 = Sunday … 6 = Saturday (Amman calendar). */
export type ShippingCutoffMode = 'before' | 'after' | 'any';
export type ShippingArrivalMode = 'offset_days' | 'next_weekday';

export type ShippingDeliveryRule = {
  id: string;
  /** Order days this rule matches. */
  days: number[];
  cutoffMode: ShippingCutoffMode;
  arrivalMode: ShippingArrivalMode;
  /** Used when arrivalMode is offset_days (1–14). */
  arrivalOffsetDays?: number;
  /** Used when arrivalMode is next_weekday (0–6). */
  arrivalWeekday?: number;
};
