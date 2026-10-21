import { evaluateLivePriceProbe } from '../src/costco/live-price-probe.js';
import { fetchWarehousePrices } from '../src/costco/price-client.js';

const [itemNumber, warehouseNumber, ...extra] = process.argv.slice(2);
if (
  !itemNumber ||
  !warehouseNumber ||
  extra.length > 0 ||
  !/^\d+$/.test(itemNumber) ||
  !/^\d+$/.test(warehouseNumber)
) {
  console.error(
    'Usage: npm run probe:live-price -- YOUR_ITEM_NUMBER YOUR_WAREHOUSE_NUMBER',
  );
  process.exit(64);
}
const sample = { itemNumber, warehouseNumber };
const samples = [sample];
const observations = await fetchWarehousePrices(samples);
const result = evaluateLivePriceProbe(samples, observations);

console.log(JSON.stringify(result.report, null, 2));
process.exitCode = result.exitCode;
