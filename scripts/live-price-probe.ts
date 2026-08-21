import { evaluateLivePriceProbe } from '../dist/costco/live-price-probe.js';
import { fetchWarehousePrices } from '../dist/costco/price-client.js';

const sample = { itemNumber: '100978861', warehouseNumber: '129' };
const samples = [sample];
const observations = await fetchWarehousePrices(samples);
const result = evaluateLivePriceProbe(samples, observations);

console.log(JSON.stringify(result.report, null, 2));
process.exitCode = result.exitCode;
