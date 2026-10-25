import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatPromoEnd } from '../src/lib/dates.js';
import { warehouseEvidenceDetails } from '../src/notifications/warehouse-evidence.js';

afterEach(() => vi.unstubAllEnvs());

describe('promotion calendar dates', () => {
  it.each([
    ['2026-11-15', '2026-11-15'],
    ['2026-11-15T08:00:00.000Z', '2026-11-15'],
    ['2026-11-15T07:59:59.000Z', '2026-11-14'],
    ['2026-11-15T00:30:00-08:00', '2026-11-15'],
    ['11/15/2026', '2026-11-15'],
    ['11/15/26', '2026-11-15'],
  ])('formats %s in the local Pacific timezone as %s', (value, expected) => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    expect(formatPromoEnd(value)).toBe(expected);
  });

  it('uses the local timezone rather than hardcoding Pacific', () => {
    vi.stubEnv('TZ', 'Asia/Tokyo');
    expect(formatPromoEnd('2026-11-15T23:30:00Z')).toBe('2026-11-16');
    expect(formatPromoEnd('2026-11-15')).toBe('2026-11-15');
  });

  it('formats receipt email/report evidence without mutating the source', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const price = {
      source: 'warehouse_display_price_api',
      warehouseEvidence: {
        warehouseNumber: '222',
        unitBasis: 'each' as const,
        promoEnd: '2026-11-15T08:00:00.000Z',
      },
    };
    expect(warehouseEvidenceDetails(price)).toContain(
      'Promotion ends: 2026-11-15',
    );
    expect(price.warehouseEvidence.promoEnd).toBe('2026-11-15T08:00:00.000Z');
  });
});
