import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Observation, WatchItem } from '../../src/watch/domain.js';
export const temp = () =>
  mkdtempSync(join(realpathSync(tmpdir()), 'pricedrop-test-'));
export const item: WatchItem = {
  id: 1,
  itemNumber: '123456',
  name: 'TEST-Example product',
  url: 'https://www.costco.com/test.product.999999.html',
  channel: 'online',
  addedAt: '2026-10-20T10:00:00Z',
};
export const observation = (
  cents: number | null,
  overrides: Partial<Observation> = {},
): Observation => ({
  itemId: 1,
  kind: 'online',
  observedAt: '2026-10-24T16:00:00Z',
  cents,
  estimateCents: null,
  source: 'synthetic-source',
  reason: cents === null ? 'not_found' : null,
  promoEnd: null,
  evidence: {},
  ...overrides,
});
