import { describe, expect, it } from 'vitest';

import {
  openLoginBrowser,
  readCostcoTokens,
  type ManualBrowserLauncher,
} from '../src/costco/browser-session.js';
import { AuthRequiredError } from '../src/costco/errors.js';
import type { AppPaths } from '../src/config/paths.js';

const paths: AppPaths = {
  browserProfileDir: '/private/tmp/costco-browser-profile',
  configFile: '/private/tmp/config.json',
  dataDir: '/private/tmp',
  databaseFile: '/private/tmp/costco.sqlite',
  logDir: '/private/tmp/logs',
  reportsDir: '/private/tmp/reports',
};

describe('Costco browser session', () => {
  it('opens manual login outside Playwright in the dedicated Chrome profile', async () => {
    const calls: Array<{ profileDirectory: string; url: string }> = [];
    const launcher: ManualBrowserLauncher = async (profileDirectory, url) => {
      calls.push({ profileDirectory, url });
    };

    await openLoginBrowser(paths, launcher);

    expect(calls).toEqual([
      {
        profileDirectory: '/private/tmp/costco-browser-profile',
        url: 'https://www.costco.com/AccountHomeView',
      },
    ]);
  });

  it('captures authorization from the live Orders request in short-lived normal Chrome', async () => {
    const events: string[] = [];
    const request = {
      async allHeaders() {
        return {
          'costco-x-authorization': 'Bearer signed-id-token',
          'costco-x-wcs-clientid': 'costco-client',
        };
      },
      url() {
        return 'https://ecom-api.costco.com/ebusiness/order/v1/orders/graphql';
      },
    };

    const tokens = await readCostcoTokens(paths, {
      allocatePort: async () => 19_223,
      connectOverCdp: async (endpoint) => {
        events.push(`connect:${endpoint}`);
        return {
          contexts: () => [
            {
              pages: () => [
                {
                  async goto(url: string) {
                    events.push(`goto:${url}`);
                  },
                  async waitForRequest(
                    predicate: (value: typeof request) => boolean,
                  ) {
                    expect(predicate(request)).toBe(true);
                    return request;
                  },
                },
              ],
            },
          ],
        };
      },
      launchChrome: async (profileDirectory, url, port) => {
        events.push(`launch:${profileDirectory}:${url}:${String(port)}`);
        return {
          async terminate() {
            events.push('terminate');
          },
        };
      },
    });

    expect(tokens).toEqual({
      clientId: 'costco-client',
      idToken: 'signed-id-token',
    });
    expect(events).toEqual([
      'launch:/private/tmp/costco-browser-profile:https://www.costco.com/AccountHomeView:19223',
      'connect:http://127.0.0.1:19223',
      'goto:https://www.costco.com/myaccount/orders',
      'terminate',
    ]);
    expect(events.join('\n')).not.toContain('signed-id-token');
  });

  it.each([
    { authorization: '', clientId: 'costco-client' },
    { authorization: 'Bearer signed-id-token', clientId: '' },
    { authorization: 'Basic wrong-scheme', clientId: 'costco-client' },
  ])(
    'requires a new login when the captured Orders authorization is unusable',
    async ({ authorization, clientId }) => {
      const events: string[] = [];

      await expect(
        readCostcoTokens(paths, {
          allocatePort: async () => 19_223,
          connectOverCdp: async () => ({
            contexts: () => [
              {
                pages: () => [
                  {
                    async goto() {},
                    async waitForRequest() {
                      return {
                        async allHeaders() {
                          return {
                            'costco-x-authorization': authorization,
                            'costco-x-wcs-clientid': clientId,
                          };
                        },
                        url: () =>
                          'https://ecom-api.costco.com/ebusiness/order/v1/orders/graphql',
                      };
                    },
                  },
                ],
              },
            ],
          }),
          launchChrome: async () => ({
            async terminate() {
              events.push('terminate');
            },
          }),
        }),
      ).rejects.toBeInstanceOf(AuthRequiredError);
      expect(events).toEqual(['terminate']);
    },
  );

  it('rejects a lookalike hostname before accepting the known Orders API host', async () => {
    const lookalike = {
      async allHeaders() {
        return {
          'costco-x-authorization': 'Bearer stolen-token',
          'costco-x-wcs-clientid': 'lookalike-client',
        };
      },
      url: () => 'https://notcostco.com/orders/graphql',
    };
    const real = {
      async allHeaders() {
        return {
          'costco-x-authorization': 'Bearer real-token',
          'costco-x-wcs-clientid': 'real-client',
        };
      },
      url: () =>
        'https://ecom-api.costco.com/ebusiness/order/v1/orders/graphql',
    };

    const tokens = await readCostcoTokens(paths, {
      allocatePort: async () => 19_223,
      connectOverCdp: async () => ({
        contexts: () => [
          {
            pages: () => [
              {
                async goto() {},
                async waitForRequest(predicate) {
                  expect(predicate(lookalike)).toBe(false);
                  expect(predicate(real)).toBe(true);
                  return real;
                },
              },
            ],
          },
        ],
      }),
      launchChrome: async () => ({ async terminate() {} }),
    });

    expect(tokens).toEqual({ clientId: 'real-client', idToken: 'real-token' });
  });
});
