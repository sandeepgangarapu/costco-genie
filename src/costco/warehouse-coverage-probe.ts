import { isUsableReportPriceEvidence } from '../core/price-evidence.js';
import {
  fetchReportPriceEvidence,
  type PriceRequest,
  type WarehousePriceOptions,
} from './price-client.js';
import type { ReportPriceObservation } from '../domain/types.js';

/** Aggregate-only public HTTP coverage. No private config, DB or browser access. */
export async function probeWarehouseCoverage(
  items: readonly string[],
  warehouseNumber: string,
  options: Pick<
    WarehousePriceOptions,
    'fetchFn' | 'now' | 'warehouseDisplayPriceFetcher'
  > = {},
) {
  if (
    !/^\d+$/u.test(warehouseNumber) ||
    /^0*847$|^0+$/u.test(warehouseNumber) ||
    items.length === 0 ||
    items.some((item) => !/^\d+$/u.test(item))
  ) {
    throw new TypeError(
      'Supply digit-only item numbers and one physical warehouse.',
    );
  }
  const requests: PriceRequest[] = [...new Set(items)].map((itemNumber) => ({
    itemNumber,
    warehouseNumber,
    purchaseChannel: 'warehouse',
  }));
  const evidence = await fetchReportPriceEvidence(requests, {
    ...options,
    // Explicitly unconfigured: the probe must never use Same-Day or a profile.
    sameDayPostalCode: null,
    sameDayRepresentativeAddress: null,
    sameDayPriceFetcher: async () => {
      throw new Error('Probe must never invoke Same-Day');
    },
  });
  const count = (
    select: (
      prices: (typeof evidence.items)[number]['prices'],
    ) => ReportPriceObservation | undefined,
  ) =>
    evidence.items.filter((item) => {
      const price = select(item.prices);
      return price && isUsableReportPriceEvidence(price, price.channel);
    }).length;
  const verified = count((p) => p.warehouse);
  return {
    probe: 'costco-public-warehouse-coverage',
    readOnly: true,
    requested: requests.length,
    display: count((p) => p.warehouseDisplay),
    savings: count((p) => p.warehouseSavings),
    strictWH: count((p) => p.warehouseGraphql),
    verifiedComparable: verified,
    sameDayWouldBeNeeded: requests.length - verified,
    diagnostics: evidence.diagnostics
      .filter((d) => d.channel !== 'same_day')
      .map((d) => ({ source: d.source, status: d.status, message: d.message })),
  };
}
