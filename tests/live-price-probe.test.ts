import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { evaluateLivePriceProbe } from '../src/costco/live-price-probe.js';
import type { PriceObservation } from '../src/domain/types.js';

const sample = { itemNumber: '100978861', warehouseNumber: '129' };
const unresolved: PriceObservation = {
  itemNumber: sample.itemNumber,
  observedAt: '2026-08-18T21:00:00.000Z',
  source: 'warehouse-price-api',
  unitPriceCents: null,
  unresolvedReason: 'not_warehouse_price',
  warehouseNumber: sample.warehouseNumber,
};

describe('evaluateLivePriceProbe', () => {
  it('uses submitted samples as the requested denominator without treating unresolved coverage as failure', () => {
    const result = evaluateLivePriceProbe([sample], [unresolved]);

    expect(result).toEqual({
      exitCode: 0,
      report: {
        batchFailed: 0,
        coverage: {
          requested: 1,
          resolved: 0,
          returned: 1,
          unresolved: 1,
        },
        observations: [unresolved],
        probe: 'costco-public-warehouse-price',
        readOnly: true,
        samples: [sample],
      },
    });
  });

  it('fails when the provider drops a submitted observation', () => {
    const result = evaluateLivePriceProbe([sample], []);

    expect(result.report.coverage).toEqual({
      requested: 1,
      resolved: 0,
      returned: 0,
      unresolved: 0,
    });
    expect(result.exitCode).toBe(1);
  });

  it('reports batch failures separately and exits nonzero', () => {
    const batchFailure: PriceObservation = {
      ...unresolved,
      unresolvedReason: 'batch_failed',
    };

    const result = evaluateLivePriceProbe([sample], [batchFailure]);

    expect(result.report.batchFailed).toBe(1);
    expect(result.exitCode).toBe(1);
  });

  it('fails when the returned observation is not the submitted item and warehouse', () => {
    const result = evaluateLivePriceProbe(
      [sample],
      [{ ...unresolved, itemNumber: '100978862' }],
    );

    expect(result.exitCode).toBe(1);
  });
});

describe('live price probe package entry point', () => {
  it('uses the IPC-free Node loader invocation', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.['probe:live-price']).toBe(
      'node --import tsx scripts/live-price-probe.ts',
    );
  });
});
