import {
  applyBatteryChargerCategorySplit,
  BATTERY_CHARGERS_VENDOR_CATEGORY_ID,
  LAPTOP_BATTERIES_CATEGORY_ID,
  LAPTOP_CHARGERS_CATEGORY_ID,
  resolveBatteryChargerCategoryId,
} from './battery-charger-category.util';

describe('battery-charger-category.util', () => {
  it('routes battery titles to Laptop Batteries', () => {
    expect(
      resolveBatteryChargerCategoryId('Dell 6-Cell Replacement Battery Pack'),
    ).toBe(LAPTOP_BATTERIES_CATEGORY_ID);
  });

  it('routes charger titles to Laptop Chargers', () => {
    expect(
      resolveBatteryChargerCategoryId('65W AC Adapter Power Supply Charger'),
    ).toBe(LAPTOP_CHARGERS_CATEGORY_ID);
  });

  it('defaults ambiguous titles to Laptop Chargers', () => {
    expect(resolveBatteryChargerCategoryId('Universal Laptop Accessory')).toBe(
      LAPTOP_CHARGERS_CATEGORY_ID,
    );
  });

  it('splits vendor category 65 imports based on searchable text', () => {
    expect(
      applyBatteryChargerCategorySplit(
        [LAPTOP_CHARGERS_CATEGORY_ID],
        BATTERY_CHARGERS_VENDOR_CATEGORY_ID,
        'HP 4-Cell Battery',
      ),
    ).toEqual([LAPTOP_BATTERIES_CATEGORY_ID]);
  });

  it('leaves unrelated vendor categories unchanged', () => {
    expect(
      applyBatteryChargerCategorySplit(
        [LAPTOP_CHARGERS_CATEGORY_ID],
        324,
        'HP 4-Cell Battery',
      ),
    ).toEqual([LAPTOP_CHARGERS_CATEGORY_ID]);
  });
});
