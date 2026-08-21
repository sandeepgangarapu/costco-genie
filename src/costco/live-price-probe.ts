import type { PriceObservation } from '../domain/types.js';
import type { WarehousePriceRequest } from './price-client.js';

export function evaluateLivePriceProbe(
  samples: readonly WarehousePriceRequest[],
  observations: readonly PriceObservation[],
) {
  const resolved = observations.filter(
    ({ unitPriceCents }) => unitPriceCents !== null,
  ).length;
  const batchFailed = observations.filter(
    ({ unresolvedReason }) => unresolvedReason === 'batch_failed',
  ).length;
  const completeMapping =
    observations.length === samples.length &&
    samples.every(
      (sample, index) =>
        observations[index]?.itemNumber === sample.itemNumber &&
        observations[index]?.warehouseNumber === sample.warehouseNumber,
    );

  return {
    exitCode: completeMapping && batchFailed === 0 ? 0 : 1,
    report: {
      batchFailed,
      coverage: {
        requested: samples.length,
        resolved,
        returned: observations.length,
        unresolved: observations.length - resolved,
      },
      observations,
      probe: 'costco-public-warehouse-price',
      readOnly: true,
      samples,
    },
  } as const;
}
