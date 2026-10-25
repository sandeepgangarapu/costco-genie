import { probeWarehouseCoverage } from '../src/costco/warehouse-coverage-probe.js';

const [warehouseNumber, ...items] = process.argv.slice(2);
if (
  !warehouseNumber ||
  !/^\d+$/u.test(warehouseNumber) ||
  /^0*847$|^0+$/u.test(warehouseNumber) ||
  items.length === 0 ||
  items.some((item) => !/^\d+$/u.test(item))
) {
  console.error(
    'Usage: npm run probe:warehouse-coverage -- YOUR_WAREHOUSE_NUMBER YOUR_ITEM_NUMBER [YOUR_ITEM_NUMBER ...]',
  );
  process.exit(64);
}
console.log(
  JSON.stringify(await probeWarehouseCoverage(items, warehouseNumber), null, 2),
);
