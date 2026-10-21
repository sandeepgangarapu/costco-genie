import { describe, expect, it } from 'vitest';

import {
  fetchSameDayPrices,
  inverseMarkupCents,
  type SameDayBrowser,
  type SameDayLocator,
  type SameDayPage,
} from '../src/costco/same-day-client.js';

const observedAt = '2026-08-21T18:00:00.000Z';
const deliveryAddress = '123 Example St, Sample City, NY 10001';

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
    '123 Example Street\nSample City, NY 10001',
  ];
  const deliveryLabel = location.deliveryLabel ?? 'Delivery 123 Example Street';

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
      if (
        selector === '[data-item-card-button="true"]' ||
        (selector.includes('[role="region"]') &&
          selector.includes('[data-item-card-button="true"]'))
      ) {
        return locator({
          click: async () => events.push('product:click'),
          count: async () => 1,
          nth: () =>
            locator({
              click: async () => events.push('product:click'),
              waitFor: async () => events.push('product:wait'),
            }),
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

interface CandidateSearch {
  readonly candidates: readonly string[];
  readonly detailWaitFails?: boolean;
  readonly noResults?: boolean;
  readonly productWaitFails?: boolean;
  readonly sponsoredCards?: number;
}

function pageWithCandidateSearches(
  searches: readonly CandidateSearch[],
  events: string[],
): SameDayPage {
  let searchIndex = -1;
  let selectedCandidate = -1;

  const currentSearch = () => searches[searchIndex] ?? { candidates: [] };
  const productLocator = (genuineOnly: boolean): SameDayLocator =>
    locator({
      click: async () => {
        selectedCandidate = 0;
        events.push('product:0:click');
      },
      count: async () =>
        currentSearch().candidates.length +
        (genuineOnly ? 0 : (currentSearch().sponsoredCards ?? 0)),
      nth: (index) =>
        locator({
          click: async () => {
            selectedCandidate = index;
            events.push(`product:${String(index)}:click`);
          },
          waitFor: async () => {
            events.push(`product:${String(index)}:wait`);
            if (currentSearch().productWaitFails) {
              throw new Error('genuine product cards did not become visible');
            }
          },
        }),
      waitFor: async () => {
        events.push('product:wait');
        if (
          currentSearch().candidates.length +
            (genuineOnly ? 0 : (currentSearch().sponsoredCards ?? 0)) >
          1
        ) {
          throw new Error('strict mode violation for multiple product cards');
        }
      },
    });

  return {
    async close() {
      events.push('page:close');
    },
    async goto(url) {
      events.push(`goto:${url}`);
      if (url.includes('?k=')) {
        searchIndex += 1;
        selectedCandidate = -1;
      }
    },
    locator(selector) {
      if (selector === 'body') {
        return locator({
          innerText: async () =>
            currentSearch().candidates[selectedCandidate] ?? '',
        });
      }
      if (selector === 'button:has-text("Browse as a guest")') {
        return locator({ count: async () => 0 });
      }
      if (selector === 'text=/Results for/i') {
        return locator({
          waitFor: async () => {
            events.push('results:wait');
            if (currentSearch().noResults) {
              throw new Error('result heading is absent');
            }
          },
        });
      }
      if (selector.includes('Sorry, we don')) {
        return locator({
          waitFor: async () => {
            events.push('no-results:wait');
            if (!currentSearch().noResults) {
              throw new Error('no-results message is absent');
            }
          },
        });
      }
      if (selector === '[data-item-card-button="true"]') {
        events.push('products:broad-selector');
        return productLocator(false);
      }
      if (
        selector.includes('[role="region"]') &&
        selector.includes('[data-item-card-button="true"]')
      ) {
        events.push('products:genuine-selector');
        return productLocator(true);
      }
      if (selector.startsWith('text=/Item:')) {
        return locator({
          waitFor: async () => {
            events.push('item:wait');
            if (currentSearch().detailWaitFails) {
              throw new Error('product detail did not become visible');
            }
          },
        });
      }
      if (selector === 'button:has-text("Back")') {
        return locator({
          click: async () => {
            events.push('header-back:click');
            throw new Error('product modal intercepts the header back control');
          },
        });
      }
      if (
        selector ===
        '[role="dialog"][aria-label="item details"] #item_details > div:first-child button'
      ) {
        return locator({
          click: async () => {
            selectedCandidate = -1;
            events.push('back:click');
          },
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
  it('ignores sponsored cards and opens the single genuine item-number result', async () => {
    const events: string[] = [];
    const browser = browserWithPages(
      [
        pageWithCandidateSearches(
          [
            {
              candidates: [
                'Veggies Made Great Frittatas\nItem: 1284156\nCurrent price: $15.88',
              ],
              sponsoredCards: 2,
            },
          ],
          events,
        ),
      ],
      events,
    );

    const [price] = await fetchSameDayPrices(
      [{ itemNumber: '1284156', warehouseNumber: '110' }],
      { launchBrowser: async () => browser, now: () => new Date(observedAt) },
    );

    expect(price).toMatchObject({
      itemNumber: '1284156',
      unavailableReason: null,
      unitPriceCents: 1_588,
    });
    expect(events).toContain('products:genuine-selector');
    expect(events).not.toContain('products:broad-selector');
  });

  it('falls back to the receipt description and verifies the exact item number before accepting a price', async () => {
    const events: string[] = [];
    const browser = browserWithPages(
      [
        pageWithCandidateSearches(
          [
            { candidates: [], noResults: true },
            {
              candidates: [
                'Item: 100001\nCurrent price: $24.96',
                'Item: 100002\nCurrent price: $32.90',
                'Item: 100003\nCurrent price: $38.58',
                'Item: 100004\nCurrent price: $38.58',
                'Kirkland Signature Organic Extra Virgin Olive Oil\nItem: 692731\nCurrent price: $19.17',
              ],
            },
          ],
          events,
        ),
      ],
      events,
    );
    const request = {
      description: 'KS ORG EVOO',
      itemNumber: '692731',
      warehouseNumber: '110',
    };

    const [price] = await fetchSameDayPrices([request], {
      launchBrowser: async () => browser,
      now: () => new Date(observedAt),
    });

    expect(price).toMatchObject({
      itemNumber: '692731',
      unavailableReason: null,
      unitPriceCents: 1_917,
    });
    expect(events).toContain(
      'goto:https://sameday.costco.com/store/costco/s?k=KS%20ORG%20EVOO',
    );
    expect(events).toContain('back:click');
    expect(events).not.toContain('header-back:click');
  });

  it('does not use the description fallback when genuine result cards fail to load', async () => {
    const events: string[] = [];
    const browser = browserWithPages(
      [
        pageWithCandidateSearches(
          [
            { candidates: ['Item: 692731'], productWaitFails: true },
            {
              candidates: [
                'Kirkland Signature Organic Extra Virgin Olive Oil\nItem: 692731\nCurrent price: $19.17',
              ],
            },
          ],
          events,
        ),
      ],
      events,
    );

    const [price] = await fetchSameDayPrices(
      [
        {
          description: 'KS ORG EVOO',
          itemNumber: '692731',
          warehouseNumber: '110',
        },
      ],
      { launchBrowser: async () => browser, now: () => new Date(observedAt) },
    );

    expect(price?.unavailableReason).toBe('search_failed');
    expect(events).not.toContain(
      'goto:https://sameday.costco.com/store/costco/s?k=KS%20ORG%20EVOO',
    );
  });

  it('does not use the description fallback when a product detail fails to load', async () => {
    const events: string[] = [];
    const browser = browserWithPages(
      [
        pageWithCandidateSearches(
          [
            { candidates: ['Item: 692731'], detailWaitFails: true },
            {
              candidates: [
                'Kirkland Signature Organic Extra Virgin Olive Oil\nItem: 692731\nCurrent price: $19.17',
              ],
            },
          ],
          events,
        ),
      ],
      events,
    );

    const [price] = await fetchSameDayPrices(
      [
        {
          description: 'KS ORG EVOO',
          itemNumber: '692731',
          warehouseNumber: '110',
        },
      ],
      { launchBrowser: async () => browser, now: () => new Date(observedAt) },
    );

    expect(price?.unavailableReason).toBe('search_failed');
    expect(events).not.toContain(
      'goto:https://sameday.costco.com/store/costco/s?k=KS%20ORG%20EVOO',
    );
  });

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
        postalCode: '10001',
        timeout: 4_321,
      },
    );

    expect(prices).toEqual([
      {
        channel: 'same_day',
        itemNumber: '1753490',
        observedAt,
        promotionText: null,
        source: 'same_day_guest_storefront_zip_10001',
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
          suggestions: ['123 Example Street Sample City, NY 10002'],
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
        postalCode: '10001',
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

  it('gives each item its own deadline so one stalled lookup does not fail later items', async () => {
    const events: string[] = [];
    const basePage = pageWithSearches(
      [
        'Item: 1753490\nCurrent price: $15.31',
        'Item: 1864962\nCurrent price: $18.15',
      ],
      events,
    );
    let bodyReads = 0;
    const page: SameDayPage = {
      ...basePage,
      locator(selector) {
        if (selector === 'body') {
          bodyReads += 1;
          return locator({
            innerText:
              bodyReads === 1
                ? () => new Promise<string>(() => undefined)
                : async () => 'Item: 1864962\nCurrent price: $18.15',
          });
        }
        return basePage.locator(selector);
      },
    };
    const browser = browserWithPages([page], events);

    const prices = await fetchSameDayPrices(
      [
        { itemNumber: '1753490', warehouseNumber: '110' },
        { itemNumber: '1864962', warehouseNumber: '110' },
      ],
      {
        launchBrowser: async () => browser,
        now: () => new Date(observedAt),
        timeout: 10,
      },
    );

    expect(prices.map((price) => price.unavailableReason)).toEqual([
      'deadline_exceeded',
      null,
    ]);
    expect(prices[1]?.unitPriceCents).toBe(1_815);
  });
});
