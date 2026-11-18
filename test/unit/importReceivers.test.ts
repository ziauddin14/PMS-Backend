import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { looseKey, matchReceivers } from '../../src/scripts/importReceivers.js';

// Synthetic names only.
const P = new ObjectId();
const DV1 = new ObjectId();
const DV2 = new ObjectId();
const DS1 = new ObjectId();
const DS2 = new ObjectId();
const C1 = new ObjectId();
const C2 = new ObjectId();
const C3 = new ObjectId();
const tree = {
  provinces: [{ _id: P, name: 'Synthetic Province' }],
  divisions: [
    { _id: DV1, name: 'S.D. Division', provinceId: P },
    { _id: DV2, name: 'Other Division', provinceId: P },
  ],
  districts: [
    { _id: DS1, name: 'District One', divisionId: DV1 },
    { _id: DS2, name: 'District Two', divisionId: DV2 },
  ],
  cities: [
    { _id: C1, name: 'Synthetic Town', districtId: DS1, active: true },
    { _id: C2, name: 'Far Town', districtId: DS2, active: true },
    { _id: C3, name: 'Closed Town', districtId: DS1, active: false },
  ],
};
const row = (over: object) => ({
  province: 'Synthetic Province',
  division: 'SD division',
  city: 'synthetic  town',
  name: 'Synthetic Receiver',
  phone: '0300-0000000',
  ...over,
});

describe('matchReceivers', () => {
  it('compares names ignoring case, spaces and punctuation', () => {
    expect(looseKey('D.G. Khan')).toBe(looseKey('dg khan'));
    const [result] = matchReceivers([row({})], tree);
    expect(result).toMatchObject({ ok: true, cityId: C1.toHexString(), rowNo: 2 });
  });

  it('only matches a city inside the given division and reports why a row is skipped', () => {
    const results = matchReceivers(
      [
        row({ city: 'Far Town' }),
        row({ province: 'Nowhere' }),
        row({ division: 'Missing' }),
        row({ city: 'Closed Town' }),
      ],
      tree,
    );
    expect(results.map((r) => (r.ok ? 'ok' : r.reason))).toEqual([
      'city "Far Town" not found in division "SD division"',
      'province "Nowhere" not found',
      'division "Missing" not found in province "Synthetic Province"',
      'city "Closed Town" is inactive',
    ]);
  });
});
