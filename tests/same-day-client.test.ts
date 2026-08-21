import { describe, expect, it } from 'vitest';

import {
  fetchSameDayPrices,
  inverseMarkupCents,
  type SameDayBrowser,
  type SameDayLocator,
  type SameDayPage,
} from '../src/costco/same-day-client.js';

const observedAt = '2026-08-21T18:00:00.000Z';
const deliveryAddress = '2520 NE Park Dr, Issaquah, WA 98029';

interface FakeLocation {
  readonly deliveryLabel?: string;
  readonly suggestions?: readonly string[];
}

function locator(overrides: Partial<SameDayLocator> = {}): SameDayLocator {
  return {
    allInnerTexts: async () => [],
    click: async () => {},
    count: async () => 0,
    fill: async () => {},
    innerText: async () => '',
    nth: () => locator(),
    press: async () => {},
    waitFor: async () => {},
    ...overrides,
  };
}

function pageWithSearches(
  searchTexts: readonly string[],
  events: string[],
  location: FakeLocation = {},
): SameDayPage {
  let searchIndex = -1;
  const suggestions = location.suggestions ?? [
    '2520 Northeast Park Drive\nIssaquah, WA 98029',
  ];
  const deliveryLabel =
    location.deliveryLabel ?? 'Delivery 2520 Northeast Park Drive';

  return {
    async close() {
      events.push('page:close');
    },
    async goto(url, options) {
      events.push(`goto:${url}:${String(options.timeout)}`);
      if (url.includes('?k=')) searchIndex += 1;
    },
    locator(selector) {
      if (selector === 'body') {
        return locator({
          innerText: async () => searchTexts[searchIndex] ?? '',
        });
      }
      if (selector === 'button:has-text("Browse as a guest")') {
        return locator({
          click: async () => events.push('guest:click'),
          count: async () => 1,
        });
      }
      if (selector === 'text=/Results for/i') {
        return locator({
          count: async () => 1,
          waitFor: async () => events.push('results:wait'),
        });
      }
      if (selector === '[data-item-card-button="true"]') {
        return locator({
          click: async () => events.push('product:click'),
          count: async () => 1,
          waitFor: async () => events.push('product:wait'),
        });
      }
      if (selector.startsWith('text=/Item:')) {
        return locator({
          waitFor: async () => events.push('item:wait'),
        });
      }
      if (selector === 'button[aria-controls]:has-text("Delivery")') {
        return locator({
          click: async () => events.push('delivery:click'),
          count: async () => 1,
          innerText: async () => deliveryLabel,
          waitFor: async () => events.push('delivery:wait'),
        });
      }
      if (selector === 'button:has-text("Edit")') {
        return locator({
          click: async () => events.push('edit:click'),
          count: async () => 1,
          waitFor: async () => events.push('edit:wait'),
        });
      }
      if (selector === '#streetAddress') {
        return locator({
          count: async () => 1,
          fill: async (value) => events.push(`address:${value}`),
          waitFor: async () => events.push('address:wait'),
        });
      }
      if (selector === '[role="option"]') {
        return locator({
          allInnerTexts: async () => [...suggestions],
          count: async () => suggestions.length,
          waitFor: async () => events.push('options:wait'),
          nth: (index) =>
            locator({
              click: async () => events.push(`suggestion:${index}`),
              waitFor: async () => events.push('options:wait'),
            }),
        });
      }
      if (selector === 'button:has-text("Save Address")') {
        return locator({
          click: async () => events.push('save:click'),
          count: async () => 1,
        });
      }
      return locator();
    },
  };
}

function browserWithPages(
  pages: Array<SameDayPage | Error>,
  events: string[],
): SameDayBrowser {
  return {
    async close() {
      events.push('browser:close');
    },
    async newPage() {
      events.push('browser:new-page');
      const next = pages.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error('No fake page configured');
      return next;
    },
  };
}

describe('inverseMarkupCents', () => {
  it('removes a percentage markup using nearest-cent rounding', () => {
    expect(inverseMarkupCents(1531, 13.5)).toBe(1349);
  });
});

describe('fetchSameDayPrices', () => {
  it('confirms the ZIP through its matching address suggestion before returning a price', async () => {
    const events: string[] = [];
    const browser = browserWithPages(
      [
        pageWithSearches(
          [
            'Aveeno Lotion\nItem: 1753490\nCurrent price: $15.31\nOriginal price: $20.00',
          ],
          events,
        ),
      ],
      events,
    );

    const prices = await fetchSameDayPrices(
      [{ itemNumber: '1753490', warehouseNumber: '129' }],
      {
        deliveryAddress,
        launchBrowser: async () => browser,
        now: () => new Date(observedAt),
        nowMilliseconds: () => 1_000,
        postalCode: '98029',
        timeout: 4_321,
      },
    );

    expect(prices).toEqual([
      {
        channel: 'same_day',
        itemNumber: '1753490',
        observedAt,
        promotionText: null,
        source: 'same_day_guest_storefront_zip_98029',
        unavailableReason: null,
        unitPriceCents: 1531,
        warehouseNumber: '129',
      },
    ]);
    expect(events).toEqual([
      'browser:new-page',
      'goto:https://sameday.costco.com/store/costco/s:4321',
      'guest:click',
      'delivery:wait',
      'delivery:click',
      'edit:wait',
      'edit:click',
      'address:wait',
      `address:${deliveryAddress}`,
      'options:wait',
      'suggestion:0',
      'save:click',
      'goto:https://sameday.costco.com/store/costco/s?k=1753490:4321',
      'results:wait',
      'product:wait',
      'product:click',
      'item:wait',
      'page:close',
      'browser:close',
    ]);
  });

  it('fails closed without a ZIP-labelled source when address selection cannot be confirmed', async () => {
    const events: string[] = [];
    const browser = browserWithPages(
      [
        pageWithSearches(['Item: 1753490\nCurrent price: $15.31'], events, {
          suggestions: ['2520 Northeast Park Drive Issaquah, WA 98028'],
        }),
      ],
      events,
    );

    const prices = await fetchSameDayPrices(
      [{ itemNumber: '1753490', warehouseNumber: '129' }],
      {
        deliveryAddress,
        launchBrowser: async () => browser,
        now: () => new Date(observedAt),
        postalCode: '98029',
      },
    );

    expect(prices).toEqual([
      {
        channel: 'same_day',
        itemNumber: '1753490',
        observedAt,
        promotionText: null,
        source: 'same_day_guest_storefront_location_unconfirmed',
        unavailableReason: 'postal_code_not_confirmed',
        unitPriceCents: null,
        warehouseNumber: '129',
      },
    ]);
    expect(events.some((event) => event.includes('?k=1753490'))).toBe(false);
    expect(events).toContain('browser:close');
  });

  it('reuses one initialized page for each exact item search and isolates unavailable items', async () => {
    const events: string[] = [];
    const browser = browserWithPages(
      [
        pageWithSearches(
          [
            'Item: 1753490\nCurrent price: $15.31',
            'Item: 1864962\nNo current price',
          ],
          events,
        ),
      ],
      events,
    );

    const prices = await fetchSameDayPrices(
      [
        { itemNumber: '1753490', warehouseNumber: '129' },
        { itemNumber: '1864962', warehouseNumber: '129' },
      ],
      { launchBrowser: async () => browser, now: () => new Date(observedAt) },
    );

    expect(prices.map((price) => price.unavailableReason)).toEqual([
      null,
      'current_price_unavailable',
    ]);
    expect(events.filter((event) => event === 'browser:new-page')).toEqual([
      'browser:new-page',
    ]);
    expect(events.filter((event) => event.includes('?k='))).toHaveLength(2);
    expect(events.filter((event) => event === 'guest:click')).toHaveLength(1);
  });

  it('rejects a search result whose product detail has a different item number', async () => {
    const events: string[] = [];
    const browser = browserWithPages(
      [pageWithSearches(['Item: 1753491\nCurrent price: $1.00'], events)],
      events,
    );

    const [price] = await fetchSameDayPrices(
      [{ itemNumber: '1753490', warehouseNumber: '110' }],
      { launchBrowser: async () => browser, now: () => new Date(observedAt) },
    );

    expect(price).toMatchObject({
      unitPriceCents: null,
      unavailableReason: 'exact_item_not_found',
    });
  });

  it('bounds a stalled detail read with the overall Same-Day deadline', async () => {
    const events: string[] = [];
    const basePage = pageWithSearches(
      ['Item: 1753490\nCurrent price: $15.31'],
      events,
    );
    const stalledPage: SameDayPage = {
      ...basePage,
      locator(selector) {
        if (selector === 'body') {
          return locator({
            innerText: () => new Promise<string>(() => undefined),
          });
        }
        return basePage.locator(selector);
      },
    };
    const browser = browserWithPages([stalledPage], events);

    const [price] = await fetchSameDayPrices(
      [{ itemNumber: '1753490', warehouseNumber: '110' }],
      {
        launchBrowser: async () => browser,
        now: () => new Date(observedAt),
        timeout: 10,
      },
    );

    expect(price).toMatchObject({ unavailableReason: 'deadline_exceeded' });
    expect(events).toContain('browser:close');
  });
});
