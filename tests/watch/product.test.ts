import { describe, expect, it, vi } from 'vitest';
import {
  parseItemInput,
  parseProductPage,
  resolveProduct,
  wireCents,
  fetchProductHtml,
} from '../../src/costco/product.js';
import {
  fetchApiPrices,
  parseApiPrices,
} from '../../src/costco/watch-online-client.js';
import { parseSavingsForItem } from '../../src/costco/warehouse-savings.js';
import {
  detectSession,
  parseDisplayedPrice,
} from '../../src/costco/online-page.js';
import { item } from './helpers.js';
const now = () => new Date('2026-10-24T16:00:00Z');
const payload = (products: unknown[]) => ({
  data: { products: { catalogData: products } },
});
const product = (price: unknown, programTypes = 'ONLINE') => ({
  itemNumber: '123456',
  programTypes,
  priceData: { price },
  description: { shortDescription: 'TEST-Example' },
});
describe('item identity and catalog', () => {
  it.each([
    'https://www.costco.com/example.product.999999.html?foo=bar',
    'https://www.costco.com/product/999999/',
    'https://www.costco.com/ProductDisplay?productId=999999',
  ])('keeps the product ID separate from the item number (%s)', (url) => {
    expect(parseItemInput(url)).toMatchObject({ productId: '999999' });
  });
  it.each([
    'https://evil.test/p/1',
    'http://www.costco.com/.product.1.html',
    'https://www.costco.com/myaccount/orders',
    'https://www.costco.com/AccountHomeView?productId=1',
    'https://u:p@www.costco.com/.product.1.html',
    'https://www.costco.com/ProductDisplay?productId=invalid',
    '123abc',
  ])('rejects unsafe input %s', (s) => {
    expect(() => parseItemInput(s)).toThrow();
  });
  it('resolves URLs from an actual SKU rather than using the product ID', async () => {
    const html =
      '<script type="application/ld+json">{"@type":"Product","sku":"123456","name":"TEST-Name"}</script><div>Item 123456</div>';
    expect(parseProductPage(html, item.url)).toEqual({
      itemNumber: '123456',
      name: 'TEST-Name',
      url: item.url,
    });
    const fetchFn = vi.fn(
      async () => new Response(html),
    ) as unknown as typeof fetch;
    expect((await resolveProduct(item.url, fetchFn)).itemNumber).toBe('123456');
    expect(
      parseProductPage(
        '<title>TEST-Title &amp; name | Costco</title>' +
          html.replace('TEST-Name', '  '),
        item.url,
      )?.name,
    ).toBe('TEST-Title & name');
    expect(parseProductPage('<p>No item number</p>', item.url)).toBeNull();
    expect(
      parseProductPage(html + '<div>Item 777777</div>', item.url),
    ).toBeNull();
  });
  it('never follows a public-page redirect to an account or external page', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://www.costco.com/myaccount/orders' },
        }),
    ) as unknown as typeof fetch;
    await expect(fetchProductHtml(item.url, fetchFn)).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['12.99000', 1299],
    [12.99, 1299],
    ['12.999', null],
    ['0', null],
    [-1, null],
    ['1,299.99', 129999],
  ])('parses wire prices %s', (value, expected) => {
    expect(wireCents(value)).toBe(expected);
  });
});
describe('public product sources', () => {
  it('requires exact unique identities and a WH program for verified warehouse prices', () => {
    expect(
      parseApiPrices(
        payload([product('12.99', 'InWarehouse,ShipIt')]),
        ['123456'],
        'warehouse',
      ).get('123456'),
    ).toMatchObject({ cents: null, reason: 'not_verified_warehouse_price' });
    expect(
      parseApiPrices(
        payload([product('12.99', 'WH')]),
        ['123456'],
        'warehouse',
      ).get('123456')?.cents,
    ).toBe(1299);
    expect(
      parseApiPrices(payload([product('12.99')]), ['123456'], 'online').get(
        '123456',
      ),
    ).toMatchObject({ cents: 1299, name: 'TEST-Example' });
    expect(
      parseApiPrices(
        payload([product('12.99'), product('12.99')]),
        ['123456'],
        'online',
      ).get('123456')?.reason,
    ).toBe('ambiguous_price');
    expect(() =>
      parseApiPrices({ errors: [{}] }, ['123456'], 'online'),
    ).toThrow();
  });
  it('uses the public identifier, online scope and bounded batches without credentials', async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify(payload([product('12.99')]))),
    ) as unknown as typeof fetch;
    await fetchApiPrices(
      Array.from({ length: 26 }, (_, i) => String(123456 + i)),
      '847',
      'online',
      fetchFn,
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const options = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][1];
    expect(options.credentials).toBe('omit');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(options.body).query).toContain('warehouseNumber: "847"');
    const failure = await fetchApiPrices(
      ['123456'],
      '847',
      'online',
      vi.fn(async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    );
    expect(failure.get('123456')?.reason).toBe('product_api_failed');
  });
});
describe('savings and online display parsing', () => {
  it('handles the observed split-line online layout only with a corroborated net total', () => {
    const fixture =
      'Item 123456\nOnline Price\n$17.99\n$4.50\nOFF\n-\n$\n13.49\n$4.50 OFF\nSavings valid through 10/30/2026\nUnit Price\n$0.81';
    expect(parseDisplayedPrice(fixture, '123456')).toMatchObject({
      cents: 1349,
      referenceCents: 1799,
      discountCents: 450,
      promoEnd: '10/30/2026',
    });
    expect(
      parseDisplayedPrice(
        'Item 123456\nOnline Price $17.99\n$4.50 OFF',
        '123456',
      ).cents,
    ).toBeNull();
    expect(
      parseDisplayedPrice(
        'Item 123456\nOnline Price $17.99\nYour Price $13.49\n$4.50 OFF',
        '123456',
      ).cents,
    ).toBe(1349);
    expect(
      parseDisplayedPrice(
        'Item 123456\nOnline Price\n$14.49\n$4.50\nOFF\n−\n$\n18.99\n$4.50 OFF\nShipping and Handling\nUnit Price $13.49',
        '123456',
      ),
    ).toMatchObject({ cents: 1449, referenceCents: 1899, discountCents: 450 });
  });
  const article = (extra = '') =>
    `<article data-item-number="123456" data-applicability="warehouse" data-start-date="2026-10-20" data-end-date="2026-10-30" ${extra}>$9.99 after $3 OFF</article>`;
  it('accepts only current explicit warehouse final prices and retains promo end', () => {
    expect(
      parseSavingsForItem(article('data-final-price="9.99"'), '123456', now()),
    ).toMatchObject({ cents: 999, promoEnd: '2026-10-30' });
    expect(parseSavingsForItem(article(), '123456', now()).cents).toBeNull();
    expect(
      parseSavingsForItem(
        article('data-final-price="9.99"'),
        '123456',
        new Date('2026-11-01'),
      ).reason,
    ).toBe('promotion_not_current');
    expect(
      parseSavingsForItem(
        article('data-final-price="9.99"').replace('warehouse', 'online'),
        '123456',
        now(),
      ).cents,
    ).toBeNull();
    expect(
      parseSavingsForItem(
        article('data-final-price="9.99"').replace(
          'warehouse"',
          ' warehouse "',
        ),
        '123456',
        now(),
      ).cents,
    ).toBe(999);
    expect(
      parseSavingsForItem(
        article('data-final-price="9.99"').replace(
          '$9.99 after $3 OFF',
          'Item numbers <b>vary</b>',
        ),
        '123456',
        now(),
      ).reason,
    ).toBe('variable_item_numbers');
    expect(
      parseSavingsForItem(
        article('data-final-price="9.99"').replace(
          '$9.99 after $3 OFF',
          'Online <b>only</b>',
        ),
        '123456',
        now(),
      ).cents,
    ).toBeNull();
  });
  it('parses escaped hydration and refuses a Save amount as a final price', () => {
    const make = (prepend: string) =>
      '<p>Valid 10/20/26 - 10/30/26</p>' +
      JSON.stringify({
        itemNumber: '123456',
        applicability: 'warehouse_online',
        pricesOffCSObject: [
          {
            value: ['9.99'],
            prepend_text: prepend,
            append_text: 'After 3 OFF',
          },
        ],
      }).replaceAll('"', '\\"');
    expect(parseSavingsForItem(make(''), '123456', now())).toMatchObject({
      cents: 999,
      promoEnd: '2026-10-30',
    });
    expect(parseSavingsForItem(make('Save'), '123456', now())).toMatchObject({
      cents: null,
      reason: 'final_price_not_listed',
    });
  });
  it('matches sibling hydration precedence, case, whitespace and invalid override fallback', () => {
    const hydrated =
      '<p>Valid 10/20/26 - 10/30/26</p>' +
      JSON.stringify({
        itemNumber: '123456',
        applicability: 'WAREHOUSE_ONLINE',
        validDatesOverride: 'See warehouse for details',
        pricesOffCSObject: [
          { value: ['8.99'], prepend_text: ' ', append_text: ' After $3 OFF ' },
        ],
      });
    expect(
      parseSavingsForItem(
        article('data-final-price="9.99"') + hydrated,
        '123456',
        now(),
      ),
    ).toMatchObject({ cents: 899, promoEnd: '2026-10-30' });
    expect(
      parseSavingsForItem(hydrated.replace('" "', '" Save "'), '123456', now())
        .cents,
    ).toBeNull();
    expect(
      parseSavingsForItem(
        hydrated.replace('WAREHOUSE_ONLINE', 'ONLINE_ONLY'),
        '123456',
        now(),
      ).cents,
    ).toBeNull();
  });
  it('distinguishes explicit final prices, reference prices, discounts and expiry', () => {
    const p = parseDisplayedPrice(
      'Sign Out\nItem 123456\nList Price $12.99\nYour Price\n$9.99\n$3 OFF\nExpires 10/30/2026',
      '123456',
    );
    expect(p).toMatchObject({
      cents: 999,
      referenceCents: 1299,
      discountCents: 300,
      promoEnd: '10/30/2026',
      session: 'authenticated',
    });
    expect(
      parseDisplayedPrice('Item 123456\n$3 OFF', '123456').cents,
    ).toBeNull();
    expect(
      parseDisplayedPrice('Item 999999\nPrice $9.99', '123456').cents,
    ).toBeNull();
    expect(
      parseDisplayedPrice('Item 123456\nPrice $9.99\nPrice $10.99', '123456')
        .cents,
    ).toBeNull();
  });
  it('detects sign-out gates and avoids treating generic navigation as authenticated', () => {
    expect(detectSession('Sign in to view member price')).toBe('signed_out');
    expect(detectSession('Sign In / Register')).toBe('unknown');
    expect(detectSession('Sign Out')).toBe('authenticated');
    expect(detectSession('Costco')).toBe('unknown');
    expect(detectSession('', 'https://www.costco.com/LogonForm')).toBe(
      'signed_out',
    );
  });
});
