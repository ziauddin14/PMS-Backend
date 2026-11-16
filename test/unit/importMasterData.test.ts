import { describe, expect, it } from 'vitest';
import { planMasterImport } from '../../src/scripts/importMasterData.js';

// Synthetic names only.
describe('planMasterImport', () => {
  const plan = planMasterImport({
    locations: [
      { province: 'P1', division: 'Dv1', district: 'Shared', city: 'C1' },
      { province: 'P1', division: 'Dv1', district: 'shared ', city: 'C2' },
      { province: 'P1', division: 'Dv2', district: 'Shared', city: 'C1' },
      { province: 'P1', division: 'Dv1', district: 'Shared', city: 'c1' },
    ],
    items: ['Item A', 'item  a'],
    warehouses: ['W1'],
    departments: [],
    vendors: [{ name: 'V1', contactPerson: 'Person' }],
  });

  it('orders levels so parents come before children', () => {
    expect(plan.map((level) => level.map((w) => w.entity))).toEqual([
      ['provinces', 'items', 'warehouses', 'vendors'],
      ['divisions', 'divisions'],
      ['districts', 'districts'],
      ['cities', 'cities', 'cities'],
    ]);
  });

  it('collapses repeated rows ignoring case and spacing, but keeps same names in other parents', () => {
    const cities = plan[3] ?? [];
    expect(new Set(cities.map((c) => c.parentKey)).size).toBe(2);
    expect(cities.map((c) => c.name)).toEqual(['C1', 'C2', 'C1']);
    expect(plan[0]?.find((w) => w.entity === 'vendors')).toMatchObject({ contactPerson: 'Person' });
  });
});
