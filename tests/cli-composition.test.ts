import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDefaultCliActions, runCli, type CliIo } from '../src/cli.js';
import { AuthRequiredError } from '../src/costco/errors.js';
import type { PriceObservation } from '../src/domain/types.js';
import { FileRunLock, RunOverlapError } from '../src/lib/process.js';
import { installLaunchAgent as installLaunchAgentImplementation } from '../src/scheduler/launchd.js';
import { Database } from '../src/storage/database.js';

const temporaryHomes: string[] = [];

function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'costco-cli-composition-'));
  temporaryHomes.push(home);
  return home;
}

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { force: true, recursive: true });
  }
});

describe('createDefaultCliActions composition', () => {
  it('persists startup choices and preserves settings on a second setup without prompting', async () => {
    const homeDirectory = temporaryHome();
    const actions = createDefaultCliActions({
      homeDirectory,
      dependencies: {
        promptSetup: async () => {
          throw new Error('explicit options must not prompt');
        },
      },
    });
    const configFile = await actions.setup({
      sameDayPostalCode: '10001',
      sameDayRepresentativeAddress: '123 Example St',
      emailRecipient: 'you@example.com',
    });
    await actions.setup({});
    expect(JSON.parse(readFileSync(configFile, 'utf8'))).toMatchObject({
      sameDayPostalCode: '10001',
      sameDayRepresentativeAddress: '123 Example St',
      emailRecipient: 'you@example.com',
    });
    await actions.setup({
      sameDayPostalCode: null,
      sameDayRepresentativeAddress: null,
    });
    expect(JSON.parse(readFileSync(configFile, 'utf8'))).toMatchObject({
      sameDayPostalCode: null,
      sameDayRepresentativeAddress: null,
      emailRecipient: 'you@example.com',
    });
    expect(lstatSync(configFile).mode & 0o777).toBe(0o600);
  });
  it('does not initialize SQLite when the parent-held run lock is unavailable', async () => {
    const homeDirectory = temporaryHome();
    let databaseOpens = 0;
    let protectedActionStarted = false;
    const lockPath = join(homeDirectory, '.costco-price-matcher', 'run.lock');
    const actions = createDefaultCliActions({
      dependencies: {
        createLock: (path) => {
          expect(path).toBe(lockPath);
          return {
            async runExclusive() {
              throw new RunOverlapError(path);
            },
          };
        },
        openDatabase: () => {
          databaseOpens += 1;
          throw new Error('database must stay unopened');
        },
        readCostcoTokens: async () => {
          protectedActionStarted = true;
          throw new Error('run must stay blocked');
        },
      },
      homeDirectory,
    });

    await expect(actions.run({ scheduled: false })).rejects.toBeInstanceOf(
      RunOverlapError,
    );
    expect(databaseOpens).toBe(0);
    expect(protectedActionStarted).toBe(false);
  });

  it('routes login to the injected browser boundary with the dedicated profile only', async () => {
    const homeDirectory = temporaryHome();
    let receivedPaths: { browserProfileDir: string } | undefined;
    let tokenReads = 0;
    const actions = createDefaultCliActions({
      dependencies: {
        openLoginBrowser: async (paths) => {
          receivedPaths = paths;
        },
        readCostcoTokens: async () => {
          tokenReads += 1;
          throw new Error('login must not read tokens headlessly');
        },
      },
      homeDirectory,
    });

    await actions.login();

    expect(receivedPaths?.browserProfileDir).toBe(
      join(homeDirectory, '.costco-price-matcher', 'browser-profile'),
    );
    expect(tokenReads).toBe(0);
  });

  it('wires live receipt adaptation, local dates, configured Mail, lock path, and database cleanup', async () => {
    const homeDirectory = temporaryHome();
    const now = new Date('2030-08-18T16:00:00.000Z');
    const receipt = {
      couponArray: [],
      itemArray: [
        {
          amount: '19.99',
          itemDescription01: 'Composed item',
          itemNumber: '100978861',
          unit: '1',
        },
      ],
      registerNumber: '7',
      transactionBarcode: '203008180001',
      transactionDateTime: '2030-08-10T18:30:00-07:00',
      transactionNumber: '4567',
      transactionType: 'Purchase',
      warehouseNumber: '129',
    };
    const observations: PriceObservation[] = [
      {
        itemNumber: '100978861',
        observedAt: now.toISOString(),
        source: 'warehouse-price-api',
        unitPriceCents: 1799,
        unresolvedReason: null,
        warehouseNumber: '129',
      },
    ];
    let requestedDates: { endDate: string; startDate: string } | undefined;
    let onlineRequestedDates:
      { endDate: string; startDate: string } | undefined;
    let priceRequests: unknown;
    let lockPath: string | undefined;
    let databaseCloses = 0;
    const localMessages: string[] = [];
    const mailMessages: Array<{ recipient: string; text: string }> = [];
    const actions = createDefaultCliActions({
      dependencies: {
        createLocalNotifier: () => ({
          async send(_title, body) {
            localMessages.push(body);
          },
        }),
        createLock: (path) => {
          lockPath = path;
          return new FileRunLock(path);
        },
        createMailNotifier: () => ({
          async resolveSelfRecipient() {
            throw new Error('configured recipient must avoid self resolution');
          },
          async send(recipient, _subject, text) {
            mailMessages.push({ recipient, text });
          },
        }),
        fetchReceipts: async (_tokens, startDate, endDate) => {
          requestedDates = { endDate, startDate };
          return [receipt];
        },
        fetchOnlineOrderPurchases: async (_tokens, startDate, endDate) => {
          onlineRequestedDates = { endDate, startDate };
          return {
            diagnostic: {
              channel: null,
              message: 'Costco.com order import completed with 0 purchases.',
              observedAt: now.toISOString(),
              source: 'costco_online_orders',
              status: 'ok',
            },
            failedDetailBatches: 0,
            purchases: [],
          };
        },
        fetchWarehousePrices: async (requests) => {
          priceRequests = requests;
          return observations;
        },
        fetchReportPriceEvidence: async (requests) => {
          priceRequests = requests;
          return {
            diagnostics: [],
            items: requests.map((request) => ({
              ...request,
              prices: {
                warehouse: {
                  channel: 'warehouse' as const,
                  observedAt: now.toISOString(),
                  promotionText: null,
                  source: 'warehouse-price-api',
                  unavailableReason: null,
                  unitPriceCents: 1799,
                },
                warehouseSavings: {
                  channel: 'warehouse_savings' as const,
                  observedAt: null,
                  promotionText: null,
                  source: null,
                  unavailableReason: 'item_not_advertised',
                  unitPriceCents: null,
                },
                costcoCom: {
                  channel: 'costco_com' as const,
                  observedAt: null,
                  promotionText: null,
                  source: null,
                  unavailableReason: 'not_available',
                  unitPriceCents: null,
                },
                sameDay: {
                  channel: 'same_day' as const,
                  observedAt: null,
                  promotionText: null,
                  source: null,
                  unavailableReason: 'source_not_configured',
                  unitPriceCents: null,
                },
              },
            })),
          };
        },
        now: () => now,
        openDatabase: (path) => {
          const database = Database.open(path);
          const close = database.close.bind(database);
          database.close = () => {
            databaseCloses += 1;
            close();
          };
          return database;
        },
        readCostcoTokens: async () => ({
          clientId: 'client-id',
          idToken: 'id-token',
        }),
      },
      homeDirectory,
    });
    await actions.setup();
    writeFileSync(
      join(homeDirectory, '.costco-price-matcher', 'config.json'),
      JSON.stringify({ emailRecipient: 'configured@example.com' }),
    );

    const summary = await actions.run({ scheduled: false });

    expect(summary).toMatchObject({
      candidatesFound: 1,
      onlinePurchasesProcessed: 0,
      onlineUnresolvedPrices: 0,
      outcome: 'success',
      warehousePurchasesProcessed: 1,
      warehouseUnresolvedPrices: 0,
    });
    expect(requestedDates).toEqual({
      endDate: '2030-08-18',
      startDate: '2030-07-14',
    });
    expect(onlineRequestedDates).toEqual(requestedDates);
    expect(priceRequests).toEqual([
      {
        description: 'Composed item',
        itemNumber: '100978861',
        purchaseChannel: 'warehouse',
        warehouseNumber: '129',
      },
    ]);
    expect(lockPath).toBe(
      join(homeDirectory, '.costco-price-matcher', 'run.lock'),
    );
    expect(localMessages[0]).toContain('Composed item');
    expect(mailMessages).toEqual([
      expect.objectContaining({ recipient: 'configured@example.com' }),
    ]);
    expect(mailMessages[0]?.text).toContain('Composed item');
    expect(databaseCloses).toBe(2);
    const dataDirectory = join(homeDirectory, '.costco-price-matcher');
    expect(summary.reportFiles).toEqual(
      expect.objectContaining({
        htmlFile: expect.stringContaining('/reports/'),
        csvFile: expect.stringContaining('/reports/'),
        jsonFile: expect.stringContaining('/reports/'),
      }),
    );
    expect(existsSync(join(dataDirectory, 'reports', 'latest.html'))).toBe(
      true,
    );
    expect(
      [
        dataDirectory,
        join(dataDirectory, 'browser-profile'),
        join(dataDirectory, 'logs'),
      ].map((path) => lstatSync(path).mode & 0o777),
    ).toEqual([0o700, 0o700, 0o700]);
    expect(
      [
        join(dataDirectory, 'config.json'),
        join(dataDirectory, 'costco.sqlite'),
        join(dataDirectory, 'run.lock'),
      ].map((path) => lstatSync(path).mode & 0o777),
    ).toEqual([0o600, 0o600, 0o600]);
  });

  it('propagates an expired receipt session through local recovery and CLI exit 3', async () => {
    const homeDirectory = temporaryHome();
    const localMessages: string[] = [];
    let mailCalls = 0;
    const actions = createDefaultCliActions({
      dependencies: {
        createLocalNotifier: () => ({
          async send(_title, body) {
            localMessages.push(body);
          },
        }),
        createLock: () => ({
          async runExclusive<T>(action: () => Promise<T>) {
            return action();
          },
        }),
        createMailNotifier: () => ({
          async resolveSelfRecipient() {
            mailCalls += 1;
            return 'self@example.com';
          },
          async send() {
            mailCalls += 1;
          },
        }),
        fetchReceipts: async () => {
          throw new AuthRequiredError();
        },
        fetchOnlineOrderPurchases: async () => {
          throw new AuthRequiredError();
        },
        readCostcoTokens: async () => ({
          clientId: 'client-id',
          idToken: 'expired-token',
        }),
      },
      homeDirectory,
    });
    await actions.setup();
    const output: string[] = [];
    const io: CliIo = {
      error: (message) => output.push(message),
      log: (message) => output.push(message),
    };

    const exitCode = await runCli(['run'], actions, io);

    expect(exitCode).toBe(3);
    expect(output.join('\n')).toContain('costco login');
    expect(localMessages).toEqual([expect.stringContaining('costco login')]);
    expect(mailCalls).toBe(0);
  });

  it('passes absolute pinned scheduler paths and the service label to install and uninstall', async () => {
    const homeDirectory = temporaryHome();
    const projectDirectory = join(homeDirectory, 'checkout');
    const nodePath = join(homeDirectory, 'runtime', 'node');
    const compiledCliPath = join(projectDirectory, 'dist', 'cli.js');
    const installs: unknown[] = [];
    const uninstalls: unknown[] = [];
    const launchctlCommands: string[] = [];
    mkdirSync(join(projectDirectory, 'dist'), { recursive: true });
    mkdirSync(join(homeDirectory, 'runtime'), { recursive: true });
    writeFileSync(nodePath, '#!/bin/sh\n');
    chmodSync(nodePath, 0o755);
    writeFileSync(compiledCliPath, '#!/usr/bin/env node\n');
    const schedulerExec = async (file: string, args: readonly string[]) => {
      if (file === nodePath) return { stderr: '', stdout: 'v22.13.0\n' };
      if (file === '/bin/launchctl') {
        launchctlCommands.push(args.join(' '));
        if (args[0] === 'print') {
          throw Object.assign(new Error('not loaded'), {
            code: 3,
            stderr: 'Could not find service',
            stdout: '',
          });
        }
      }
      return { stderr: '', stdout: '' };
    };
    const actions = createDefaultCliActions({
      dependencies: {
        compiledCliPath,
        getUid: () => 777,
        installLaunchAgent: async (options) => {
          installs.push(options);
          await installLaunchAgentImplementation({
            ...options,
            execFile: schedulerExec,
          });
        },
        nodePath,
        projectDirectory,
        uninstallLaunchAgent: async (options) => {
          uninstalls.push(options);
          const { uninstallLaunchAgent } =
            await import('../src/scheduler/launchd.js');
          await uninstallLaunchAgent({ ...options, execFile: schedulerExec });
        },
      },
      homeDirectory,
    });
    await actions.setup();

    const plistPath = await actions.installAgent();
    await actions.uninstallAgent();

    expect(isAbsolute(plistPath)).toBe(true);
    expect(installs).toEqual([
      expect.objectContaining({
        plistPath,
        renderOptions: expect.objectContaining({
          cliPath: compiledCliPath,
          label: 'com.costco-price-matcher.daily',
          nodePath,
          workingDirectory: projectDirectory,
        }),
        uid: 777,
      }),
    ]);
    expect(uninstalls).toEqual([
      {
        label: 'com.costco-price-matcher.daily',
        plistPath,
        uid: 777,
      },
    ]);
    expect(launchctlCommands).toEqual([
      'print gui/777/com.costco-price-matcher.daily',
      `bootstrap gui/777 ${plistPath}`,
      'bootout gui/777/com.costco-price-matcher.daily',
    ]);
    expect(existsSync(plistPath)).toBe(false);
  });

  it('rejects the pinned unsupported Node runtime before writing or loading an agent', async () => {
    const homeDirectory = temporaryHome();
    const runtimeDirectory = join(homeDirectory, 'runtime');
    const checkout = join(homeDirectory, 'checkout');
    const nodePath = join(runtimeDirectory, 'node');
    const cliPath = join(checkout, 'dist', 'cli.js');
    mkdirSync(runtimeDirectory, { recursive: true });
    mkdirSync(join(checkout, 'dist'), { recursive: true });
    writeFileSync(nodePath, '#!/bin/sh\n');
    chmodSync(nodePath, 0o755);
    writeFileSync(cliPath, '#!/usr/bin/env node\n');
    let launchctlCalls = 0;
    const actions = createDefaultCliActions({
      dependencies: {
        compiledCliPath: cliPath,
        installLaunchAgent: (options) =>
          installLaunchAgentImplementation({
            ...options,
            execFile: async (file) => {
              if (file === nodePath) {
                return { stderr: '', stdout: 'v22.12.9\n' };
              }
              if (file === '/bin/launchctl') launchctlCalls += 1;
              return { stderr: '', stdout: '' };
            },
          }),
        nodePath,
        projectDirectory: checkout,
      },
      homeDirectory,
    });
    await actions.setup();

    await expect(actions.installAgent()).rejects.toThrow(/Node 22\.13\.0/);
    expect(launchctlCalls).toBe(0);
    expect(
      existsSync(
        join(
          homeDirectory,
          'Library',
          'LaunchAgents',
          'com.costco-price-matcher.daily.plist',
        ),
      ),
    ).toBe(false);
  });
});
