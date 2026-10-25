import { describe, expect, it } from 'vitest';
import {
  detectSession,
  parseDisplayedPrice,
} from '../../src/costco/online-page.js';
import { parseApiPrices } from '../../src/costco/watch-online-client.js';
import { fetchProductHtml } from '../../src/costco/product.js';

describe('online applicability and product detail boundaries', () => {
  const warehouseLayout =
    'Sign In / Register\nWarehouse Only\nTEST-Butter\nItem TEST-BUTTER\nWarehouse Price\n$14.99\n$7.50/per pound\nHow To Get It\n10001\nUnavailable\nTEST-Warehouse\nIn Stock\nIn-Warehouse\nWarehouse Price\n$\n14.99\nSame-Day Delivery\nPricing May Vary\nIn stock at your selected warehouse.';
  it('rejects both warehouse labels in the observed layout and detects the pill before the item', () => {
    expect(parseDisplayedPrice(warehouseLayout, 'TEST-BUTTER')).toMatchObject({
      cents: null,
      warehouseOnly: true,
      memberGate: false,
      session: 'unknown',
    });
    expect(
      parseDisplayedPrice(
        warehouseLayout.replace('Warehouse Only\n', ''),
        'TEST-BUTTER',
      ),
    ).toMatchObject({ cents: null, warehouseOnly: false });
  });

  it.each([
    'Price',
    'Warehouse Price',
    'Unit Price',
    'List Price',
    'Regular Price',
    'Original Price',
  ])('does not accept %s as an online current price', (label) => {
    expect(
      parseDisplayedPrice(`Item TEST-ONLINE\n${label}\n$14.99`, 'TEST-ONLINE')
        .cents,
    ).toBeNull();
  });

  it.each([
    'Online Price',
    'Your Price',
    'Price after savings',
    'Member Price',
    'Current Price',
    'Sale Price',
  ])('accepts the applicable %s label before fulfillment', (label) => {
    expect(
      parseDisplayedPrice(
        `Sign In / Register\nItem TEST-ONLINE\n${label}\n$49.99\nHow To Get It\nWarehouse Price $14.99\nYour Price $9.99\n$5 OFF\nExpires 10/30/2026\nSign in to see price`,
        'TEST-ONLINE',
      ),
    ).toMatchObject({
      cents: 4999,
      discountCents: null,
      promoEnd: null,
      memberGate: false,
      session: 'unknown',
    });
  });

  it('never accepts a label within fulfillment or recommendations', () => {
    for (const heading of [
      'How To Get It',
      'Related Products',
      'Product Details',
    ]) {
      expect(
        parseDisplayedPrice(
          `Item TEST-ONLINE\n${heading}\nOnline Price $9.99`,
          'TEST-ONLINE',
        ).cents,
      ).toBeNull();
    }
  });

  it('gives an explicit final price precedence over a corroborated online reference layout', () => {
    expect(
      parseDisplayedPrice(
        'Item TEST-ONLINE\nOnline Price $19.99\nOnline Price $14.99',
        'TEST-ONLINE',
      ).cents,
    ).toBeNull();
    expect(
      parseDisplayedPrice(
        'Item TEST-ONLINE\nOnline Price $19.99\n$5 OFF\n$14.99\nYour Price $12.99',
        'TEST-ONLINE',
      ).cents,
    ).toBe(1299);
    expect(
      parseDisplayedPrice(
        'Item TEST-ONLINE\nYour Price $12.99\nMember Price $14.99',
        'TEST-ONLINE',
      ).cents,
    ).toBeNull();
  });

  it('keeps generic navigation and ungated member-price labels distinct from price gates', () => {
    expect(detectSession('Sign In / Register')).toBe('unknown');
    expect(
      parseDisplayedPrice(
        'Item TEST-ONLINE\nMember-only Price $49.99',
        'TEST-ONLINE',
      ),
    ).toMatchObject({ cents: 4999, memberGate: false });
    expect(
      parseDisplayedPrice(
        'Item TEST-ONLINE\nSign in to see price',
        'TEST-ONLINE',
      ),
    ).toMatchObject({ cents: null, memberGate: true, session: 'signed_out' });
    expect(
      parseDisplayedPrice(
        'Sign in to see price\nItem TEST-OTHER',
        'TEST-ONLINE',
      ).session,
    ).toBe('unknown');
  });

  it('ignores explicit warehouse-only API prices and does not treat nonbuyable metadata as an online price', () => {
    const parse = (metadata: object) =>
      parseApiPrices(
        {
          data: {
            products: {
              catalogData: [
                {
                  itemNumber: 'TEST-ITEM',
                  priceData: { price: 17.49 },
                  ...metadata,
                },
              ],
            },
          },
        },
        ['TEST-ITEM'],
        'online',
      ).get('TEST-ITEM');
    expect(parse({ programTypes: 'WarehouseOnly' })).toMatchObject({
      cents: null,
      warehouseOnly: true,
      reason: 'warehouse_only',
    });
    expect(
      parse({ attributes: [{ key: 'TEST-Pill', value: 'Warehouse Only' }] }),
    ).toMatchObject({ cents: null, reason: 'warehouse_only' });
    expect(
      parse({ buyable: 0, programTypes: 'InWarehouse,ShipIt' }),
    ).toMatchObject({
      cents: null,
      warehouseOnly: false,
      reason: 'not_online_buyable',
    });
    expect(
      parse({ buyable: 1, programTypes: 'InWarehouse,ShipIt' }),
    ).toMatchObject({ cents: 1749, warehouseOnly: false });
  });

  it('recognizes a public login redirect without following it or contacting account pages', async () => {
    let calls = 0;
    const page = await fetchProductHtml(
      'https://www.costco.com/.product.123456.html',
      async () => {
        calls += 1;
        return new Response(null, {
          status: 302,
          headers: { location: '/LogonForm' },
        });
      },
    );
    expect(calls).toBe(1);
    expect(
      parseDisplayedPrice(page!.html, 'TEST-ONLINE', page!.url),
    ).toMatchObject({ session: 'signed_out', memberGate: true });
  });
});
