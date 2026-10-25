import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

import { chromium } from 'playwright';

import type { AppPaths } from '../config/paths.js';
import { chromeBinaryPath } from './chrome-path.js';
import { AuthRequiredError } from './errors.js';
import { parseItemInput } from './product.js';
import { parseDisplayedPrice, type DisplayedPrice } from './online-page.js';

const LOGIN_URL = 'https://www.costco.com/AccountHomeView';
const ORDERS_URL = 'https://www.costco.com/myaccount/orders';
const CHROME_BINARY = chromeBinaryPath();
const CDP_CONNECT_TIMEOUT_MILLISECONDS = 20_000;
const ORDER_REQUEST_TIMEOUT_MILLISECONDS = 30_000;

export interface CostcoTokens {
  readonly clientId: string;
  readonly idToken: string;
}

export interface CapturedRequestLike {
  allHeaders(): Promise<Record<string, string>>;
  url(): string;
}

export interface CdpPageLike {
  goto(url: string): Promise<unknown>;
  waitForRequest(
    predicate: (request: CapturedRequestLike) => boolean,
    options?: { readonly timeout: number },
  ): Promise<CapturedRequestLike>;
}

export interface CdpBrowserLike {
  contexts(): Array<{
    pages(): CdpPageLike[];
  }>;
}

export interface SpawnedChrome {
  terminate(): Promise<void>;
}

export interface CostcoSessionCaptureOptions {
  readonly allocatePort?: () => Promise<number>;
  readonly connectOverCdp?: (endpoint: string) => Promise<CdpBrowserLike>;
  readonly launchChrome?: (
    profileDirectory: string,
    url: string,
    port: number,
  ) => Promise<SpawnedChrome>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export type ManualBrowserLauncher = (
  profileDirectory: string,
  url: string,
) => Promise<void>;

const launchManualChrome: ManualBrowserLauncher = (profileDirectory, url) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      CHROME_BINARY,
      [
        `--user-data-dir=${profileDirectory}`,
        '--disable-background-mode',
        '--new-window',
        url,
      ],
      { stdio: 'ignore' },
    );

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0 || signal === 'SIGTERM') {
        resolve();
        return;
      }
      reject(
        new Error(
          `Manual Chrome login exited unexpectedly (${signal ?? String(code)})`,
        ),
      );
    });
  });

export async function openLoginBrowser(
  paths: AppPaths,
  launcher: ManualBrowserLauncher = launchManualChrome,
): Promise<void> {
  await launcher(paths.browserProfileDir, LOGIN_URL);
}

export async function readCostcoTokens(
  paths: AppPaths,
  options: CostcoSessionCaptureOptions = {},
): Promise<CostcoTokens> {
  const port = await (options.allocatePort ?? allocateLoopbackPort)();
  const launched = await (options.launchChrome ?? launchCaptureChrome)(
    paths.browserProfileDir,
    LOGIN_URL,
    port,
  );

  try {
    const endpoint = `http://127.0.0.1:${String(port)}`;
    const browser = await connectWithRetry(
      endpoint,
      options.connectOverCdp ?? connectOverCdp,
      options.sleep ?? delay,
    );
    const page = browser.contexts()[0]?.pages()[0];
    if (!page) throw new AuthRequiredError();

    const requestPromise = page.waitForRequest(isOrdersGraphqlRequest, {
      timeout: ORDER_REQUEST_TIMEOUT_MILLISECONDS,
    });
    await page.goto(ORDERS_URL);
    let request: CapturedRequestLike;
    try {
      request = await requestPromise;
    } catch {
      throw new AuthRequiredError();
    }

    const headers = await request.allHeaders();
    const clientId = header(headers, 'costco-x-wcs-clientid');
    const authorization = header(headers, 'costco-x-authorization');
    const match = /^Bearer\s+(.+)$/iu.exec(authorization ?? '');
    const idToken = match?.[1]?.trim();
    if (!clientId?.trim() || !idToken) throw new AuthRequiredError();

    return { clientId: clientId.trim(), idToken };
  } finally {
    await launched.terminate();
  }
}

function isOrdersGraphqlRequest(request: CapturedRequestLike): boolean {
  try {
    const url = new URL(request.url());
    return (
      url.hostname === 'ecom-api.costco.com' &&
      url.pathname === '/ebusiness/order/v1/orders/graphql'
    );
  } catch {
    return false;
  }
}

function header(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  const expected = name.toLowerCase();
  return Object.entries(headers).find(
    ([key]) => key.toLowerCase() === expected,
  )?.[1];
}

async function connectWithRetry(
  endpoint: string,
  connector: (endpoint: string) => Promise<CdpBrowserLike>,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<CdpBrowserLike> {
  const deadline = Date.now() + CDP_CONNECT_TIMEOUT_MILLISECONDS;
  let lastError: unknown;
  do {
    try {
      return await connector(endpoint);
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  } while (Date.now() < deadline);
  throw lastError instanceof Error
    ? lastError
    : new Error('Chrome debugging endpoint was unavailable');
}

async function connectOverCdp(endpoint: string): Promise<CdpBrowserLike> {
  return (await chromium.connectOverCDP(endpoint)) as unknown as CdpBrowserLike;
}

function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a Chrome debugging port'));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function launchCaptureChrome(
  profileDirectory: string,
  url: string,
  port: number,
  headless = false,
): Promise<SpawnedChrome> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      CHROME_BINARY,
      [
        `--user-data-dir=${profileDirectory}`,
        `--remote-debugging-port=${String(port)}`,
        '--remote-debugging-address=127.0.0.1',
        '--disable-background-mode',
        '--no-first-run',
        ...(headless
          ? [
              '--headless=new',
              '--no-startup-window',
              '--disable-session-crashed-bubble',
            ]
          : ['--new-window']),
        url,
      ],
      { stdio: 'ignore' },
    );
    child.once('error', reject);
    child.once('spawn', () => {
      resolve({
        async terminate() {
          if (child.exitCode !== null || child.signalCode !== null) return;
          child.kill('SIGTERM');
          await new Promise<void>((done) => {
            const timer = setTimeout(() => {
              if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGKILL');
              }
            }, 2_000);
            timer.unref();
            child.once('exit', () => {
              clearTimeout(timer);
              done();
            });
          });
        },
      });
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// Ported watch product parsing; the caller holds the matcher's run.lock for the entire lifecycle.
export interface ProductSession {
  read(url: string, itemNumber: string): Promise<DisplayedPrice>;
  close(): Promise<void>;
}
export interface BrowserProduct {
  itemNumber: string;
  url: string;
}
export interface BrowserResult {
  prices: Map<string, DisplayedPrice>;
  diagnostic: string | null;
}
export async function readWatchProductPricesLocked(
  paths: AppPaths,
  items: readonly BrowserProduct[],
  openSession: (
    profile: string,
  ) => Promise<ProductSession> = openProductSession,
): Promise<BrowserResult> {
  const prices = new Map<string, DisplayedPrice>();
  if (!items.length) return { prices, diagnostic: null };
  try {
    const session = await openSession(paths.browserProfileDir);
    let failed = 0;
    try {
      for (const item of items) {
        try {
          const parsed = parseItemInput(item.url);
          if (!('url' in parsed))
            throw new Error('Expected public product URL');
          prices.set(
            item.itemNumber,
            await session.read(parsed.url, item.itemNumber),
          );
        } catch {
          failed += 1;
        }
      }
      return {
        prices,
        diagnostic: failed
          ? 'Signed-in product page unavailable for ' + failed + ' item(s).'
          : null,
      };
    } finally {
      await session.close();
    }
  } catch {
    return {
      prices,
      diagnostic:
        'Signed-in product source unavailable; close the dedicated Chrome window and check the app profile.',
    };
  }
}
async function openProductSession(profile: string): Promise<ProductSession> {
  const port = await allocateLoopbackPort();
  const launched = await launchCaptureChrome(
    profile,
    'about:blank',
    port,
    true,
  );
  const terminate = () => launched.terminate();
  try {
    const deadline = Date.now() + 20_000;
    let browser;
    while (!browser) {
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
          timeout: 2_000,
        });
      } catch {
        if (Date.now() >= deadline) throw new Error('Chrome CDP unavailable');
        await delay(250);
      }
    }
    const context = browser.contexts()[0];
    if (!context) throw new Error('Chrome context unavailable');
    return {
      async read(url, itemNumber) {
        const page = await context.newPage();
        let authRedirect = false;
        try {
          await page.route('**/*', async (route) => {
            const request = route.request();
            if (
              request.isNavigationRequest() &&
              request.frame() === page.mainFrame()
            ) {
              try {
                parseItemInput(request.url());
              } catch {
                authRedirect = /logon|signin|login/iu.test(request.url());
                await route.abort();
                return;
              }
            }
            await route.continue();
          });
          await page
            .goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
            .catch(() => undefined);
          if (authRedirect)
            return {
              ...parseDisplayedPrice('', itemNumber),
              session: 'signed_out',
              memberGate: true,
            };
          await page.locator('body').waitFor({ timeout: 10_000 });
          // Wait for client-rendered pricing, not merely the item heading.
          const deadline = Date.now() + 15_000;
          let text = '';
          let result: DisplayedPrice;
          do {
            text = await page.locator('body').innerText({ timeout: 10_000 });
            result = parseDisplayedPrice(text, itemNumber, page.url());
            if (
              result.cents !== null ||
              result.warehouseOnly ||
              result.session === 'signed_out' ||
              /access denied|verify you are human|captcha/iu.test(text)
            )
              break;
            await delay(500);
          } while (Date.now() < deadline);
          if (authRedirect) {
            result.session = 'signed_out';
            result.memberGate = true;
            result.cents = null;
          }
          return result;
        } finally {
          await page.close();
        }
      },
      close: terminate,
    };
  } catch (error) {
    await terminate();
    throw error;
  }
}
