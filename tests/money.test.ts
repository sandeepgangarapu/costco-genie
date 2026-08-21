import { describe, expect, it } from 'vitest';

import { parseMoneyToCents } from '../src/lib/money.js';

describe('parseMoneyToCents', () => {
  it.each([
    ['19.99', 1999],
    ['1,234.56', 123456],
    ['-0.01', -1],
    ['-1,234.50', -123450],
  ])('converts %s to %i cents', (value, expected) => {
    expect(parseMoneyToCents(value)).toBe(expected);
  });

  it.each(['', '19.999', '1,23.45', 'not money', null, 19.99])(
    'returns null for invalid monetary input %j',
    (value) => {
      expect(parseMoneyToCents(value)).toBeNull();
    },
  );

  it('rejects a value whose cents exceed Number.MAX_SAFE_INTEGER', () => {
    expect(parseMoneyToCents('90071992547409.92')).toBeNull();
  });
});
