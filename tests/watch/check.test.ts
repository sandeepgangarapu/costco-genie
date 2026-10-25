import { afterEach, describe, expect, it, vi } from 'vitest';
import { check } from '../../src/watch/check.js';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import { evaluateLow, type SourceResult } from '../../src/watch/domain.js';
import { Store } from '../../src/watch/store.js';
import { item, observation } from './helpers.js';
const stores: Store[] = [];
const makeStore = () => {
  const s = new Store(':memory:');
  stores.push(s);
  s.add(item);
  return s;
};
afterEach(() => {
  stores.forEach((s) => s.close());
  stores.length = 0;
});
const result = (
  cents: number | null,
  session: SourceResult['session'] = 'not_attempted',
): SourceResult => ({
  observations: [observation(cents)],
  session,
  diagnostics: [],
});
const clock = () => new Date('2026-10-24T16:00:00Z');
describe('lowest usable price since addition', () => {
  it('baselines, ignores equals and rebounds, and alerts only on a further low', async () => {
    const s = makeStore();
    const mail = vi.fn(async () => {});
    for (const cents of [1000, 1000, 1200, 900, 1000, 900, 800])
      await check(
        s,
        DEFAULT_CONFIG,
        async () => result(cents),
        mail,
        {},
        clock,
      );
    expect(mail).toHaveBeenCalledTimes(2);
    expect(s.low(1, 'online')).toMatchObject({
      baselineCents: 1000,
      lowCents: 800,
    });
    expect(s.history(1)).toHaveLength(7);
    expect(s.pending()).toHaveLength(0);
  });
  it('keeps each kind separate and compares raw Same-Day cents', async () => {
    const s = makeStore();
    s.add({ ...item, channel: 'both' });
    const mail = vi.fn(async () => {});
    const fetcher = (c: number) => async () => ({
      observations: [
        observation(1000),
        observation(900, { kind: 'warehouse' }),
        observation(c, { kind: 'warehouse_estimate', estimateCents: 881 }),
      ],
      session: 'not_attempted' as const,
      diagnostics: [],
    });
    await check(s, DEFAULT_CONFIG, fetcher(1000), mail, {}, clock);
    await check(s, DEFAULT_CONFIG, fetcher(999), mail, {}, clock);
    expect(mail).toHaveBeenCalledTimes(1);
    expect(s.low(1, 'warehouse_estimate')?.lowCents).toBe(999);
    expect(mail.mock.calls[0]).toBeDefined();
  });
  it('retains the alert low until small drops cumulatively meet the threshold', async () => {
    const s = makeStore();
    const mail = vi.fn(async () => {});
    const c = { ...DEFAULT_CONFIG, minimumDropCents: 10 };
    for (const n of [1000, 995, 998, 990, 985])
      await check(s, c, async () => result(n), mail, {}, clock);
    expect(mail).toHaveBeenCalledTimes(1);
    expect(s.low(1, 'online')?.lowCents).toBe(990);
    expect(s.history(1).map((o) => o.cents)).toEqual([
      985, 990, 998, 995, 1000,
    ]);
    await check(s, c, async () => result(980), mail, {}, clock);
    expect(mail).toHaveBeenCalledTimes(2);
    expect(s.low(1, 'online')?.lowCents).toBe(980);
  });
  it.each(['online', 'warehouse', 'warehouse_estimate'] as const)(
    'flags a >50%% drop in %s without poisoning the low',
    async (kind) => {
      const previous = { itemId: 1, kind, lowCents: 1000, baselineCents: 1200 };
      expect(
        evaluateLow(previous, observation(499, { kind }), 1),
      ).toMatchObject({
        low: previous,
        alert: true,
        unverifiedReason: expect.stringContaining('50%'),
      });
      expect(
        evaluateLow(previous, observation(500, { kind }), 1),
      ).toMatchObject({
        low: { ...previous, lowCents: 500 },
        alert: true,
        unverifiedReason: undefined,
      });
    },
  );
  it('flags API/display conflicts, preserves the baseline and queues a clearly marked warning', async () => {
    const s = makeStore();
    const mail = vi.fn(async () => {});
    await check(s, DEFAULT_CONFIG, async () => result(1000), mail, {}, clock);
    const source = {
      ...result(900),
      observations: [
        observation(900, { evidence: { apiCents: 2000, displayedCents: 900 } }),
      ],
    };
    const warning = await check(
      s,
      DEFAULT_CONFIG,
      async () => source,
      mail,
      {},
      clock,
    );
    expect(warning.drops[0].unverifiedReason).toContain('API');
    expect(s.low(1, 'online')?.lowCents).toBe(1000);
    const message = (mail.mock.calls as unknown[][])[0][0] as {
      subject: string;
      text: string;
      html: string;
    };
    expect(message.subject).toContain('unverified');
    for (const body of [message.text, message.html]) {
      expect(body).toContain('unverified — check before buying');
      expect(body).toContain('Stored low unchanged');
    }
    await check(s, DEFAULT_CONFIG, async () => result(950), mail, {}, clock);
    expect(s.low(1, 'online')?.lowCents).toBe(950);
  });
  it('does not establish a baseline from conflicting API/display evidence', () => {
    const o = observation(900, {
      evidence: { apiCents: 2000, displayedCents: 900 },
    });
    expect(evaluateLow(undefined, o, 1)).toMatchObject({
      low: undefined,
      alert: false,
      unverifiedReason: expect.any(String),
    });
    expect(
      evaluateLow(
        undefined,
        observation(1000, {
          evidence: { apiCents: 2000, displayedCents: 1000 },
        }),
        1,
      ).low?.baselineCents,
    ).toBe(1000);
  });
  it('retries an unverified warning without changing the stored low', async () => {
    const s = makeStore();
    const mail = vi.fn(async () => {});
    await check(s, DEFAULT_CONFIG, async () => result(1000), mail, {}, clock);
    mail.mockRejectedValueOnce(new Error('TEST-delivery'));
    await check(s, DEFAULT_CONFIG, async () => result(100), mail, {}, clock);
    expect(s.pending()[0].drop.unverifiedReason).toContain('50%');
    expect(s.low(1, 'online')?.lowCents).toBe(1000);
    await check(s, DEFAULT_CONFIG, async () => result(1000), mail, {}, clock);
    expect(s.pending()).toHaveLength(0);
    expect((mail.mock.calls as unknown[][])[1][0]).toMatchObject({
      text: expect.stringContaining('unverified — check before buying'),
    });
  });
  it('sends an unverified warning once per new unverified low', async () => {
    const s = makeStore();
    const mail = vi.fn(async () => {});
    await check(s, DEFAULT_CONFIG, async () => result(1000), mail, {}, clock);
    await check(s, DEFAULT_CONFIG, async () => result(400), mail, {}, clock);
    await check(s, DEFAULT_CONFIG, async () => result(400), mail, {}, clock);
    expect(mail).toHaveBeenCalledTimes(1);
    await check(s, DEFAULT_CONFIG, async () => result(300), mail, {}, clock);
    expect(mail).toHaveBeenCalledTimes(2);
    expect(s.low(1, 'online')?.lowCents).toBe(1000);
  });
  it('delays a missing baseline until the first usable observation', async () => {
    const s = makeStore();
    const mail = vi.fn(async () => {});
    await check(s, DEFAULT_CONFIG, async () => result(null), mail, {}, clock);
    await check(s, DEFAULT_CONFIG, async () => result(1000), mail, {}, clock);
    expect(mail).not.toHaveBeenCalled();
    expect(s.low(1, 'online')?.baselineCents).toBe(1000);
    expect(evaluateLow(undefined, observation(0), 1).low).toBeUndefined();
    expect(evaluateLow(undefined, observation(1.2), 1).low).toBeUndefined();
  });
  it('never alerts from add baseline and never mutates state in dry-run', async () => {
    const s = makeStore();
    const mail = vi.fn(async () => {});
    await check(
      s,
      DEFAULT_CONFIG,
      async () => result(1000),
      mail,
      { baseline: true },
      clock,
    );
    const before = s.db.serialize();
    const dry = await check(
      s,
      DEFAULT_CONFIG,
      async () => result(500, 'signed_out'),
      mail,
      { dryRun: true, scheduled: true },
      clock,
    );
    expect(dry.drops).toHaveLength(1);
    expect(s.db.serialize()).toEqual(before);
    expect(mail).not.toHaveBeenCalled();
    await check(s, DEFAULT_CONFIG, async () => result(500), mail, {}, clock);
    expect(mail).toHaveBeenCalledTimes(1);
  });
  it('sends one consolidated drop email and persists delivery failure for retry', async () => {
    const s = makeStore();
    s.add({ ...item, itemNumber: '123457', name: 'TEST-second' });
    const fetcher = (c: number) => async () => ({
      observations: [observation(c), observation(c, { itemId: 2 })],
      session: 'not_attempted' as const,
      diagnostics: [],
    });
    const mail = vi.fn(async () => {});
    await check(s, DEFAULT_CONFIG, fetcher(1000), mail, {}, clock);
    mail.mockRejectedValueOnce(new Error('synthetic SMTP failure'));
    expect(
      (await check(s, DEFAULT_CONFIG, fetcher(900), mail, {}, clock)).status,
    ).toBe('failure');
    expect(s.pending()).toHaveLength(2);
    await check(s, DEFAULT_CONFIG, fetcher(950), mail, {}, clock);
    expect(mail).toHaveBeenCalledTimes(2);
    expect(s.pending()).toHaveLength(0);
    expect((mail.mock.calls as unknown[][])[1][0]).toMatchObject({
      subject: 'Costco Genie: 2 items hit new lows',
    });
  });
  it('emails session expiry once until an authenticated result resets the episode', async () => {
    const s = makeStore();
    const mail = vi.fn(async () => {});
    for (const state of [
      'signed_out',
      'signed_out',
      'unknown',
      'authenticated',
      'signed_out',
    ] as const)
      await check(
        s,
        DEFAULT_CONFIG,
        async () => result(1000, state),
        mail,
        {},
        clock,
      );
    expect(mail).toHaveBeenCalledTimes(2);
    expect((mail.mock.calls as unknown[][])[0][0]).toMatchObject({
      subject: expect.stringContaining('Costco session expired'),
    });
  });
  it('clears a legacy expiry flag when no price gate is seen and starts a new gate episode', async () => {
    const s = makeStore();
    const mail = vi.fn(async () => {});
    s.setState('sessionExpired', 'true');
    s.setState('sessionNotified', 'false');
    await check(
      s,
      DEFAULT_CONFIG,
      async () => result(1000, 'not_required'),
      mail,
      {},
      clock,
    );
    expect(s.state('sessionExpired')).toBe('false');
    expect(s.state('sessionNotified')).toBe('false');
    expect(mail).not.toHaveBeenCalled();
    await check(
      s,
      DEFAULT_CONFIG,
      async () => result(1000, 'signed_out'),
      mail,
      {},
      clock,
    );
    expect(mail).toHaveBeenCalledTimes(1);
    await check(
      s,
      DEFAULT_CONFIG,
      async () => result(1000, 'not_required'),
      mail,
      {},
      clock,
    );
    expect(s.state('sessionExpired')).toBe('false');
    await check(
      s,
      DEFAULT_CONFIG,
      async () => result(1000, 'signed_out'),
      mail,
      {},
      clock,
    );
    expect(mail).toHaveBeenCalledTimes(2);
  });
  it('never delivers a stale expiry notice on an ambiguous or failed lookup', async () => {
    const s = makeStore();
    const mail = vi.fn(async () => {});
    s.setState('sessionExpired', 'true');
    s.setState('sessionNotified', 'false');
    await check(
      s,
      DEFAULT_CONFIG,
      async () => result(null, 'unknown'),
      mail,
      {},
      clock,
    );
    await check(
      s,
      DEFAULT_CONFIG,
      async () => {
        throw new Error('TEST-source-failed');
      },
      mail,
      {},
      clock,
    );
    expect(mail).not.toHaveBeenCalled();
    await check(
      s,
      DEFAULT_CONFIG,
      async () => result(1000, 'signed_out'),
      mail,
      {},
      clock,
    );
    expect(mail).toHaveBeenCalledTimes(1);
  });
  it('alerts after three scheduled failures once per streak, including thrown source errors', async () => {
    const s = makeStore();
    const mail = vi.fn(async () => {});
    const fail = async () => {
      throw new Error('TEST-source');
    };
    for (let i = 0; i < 5; i++)
      await check(
        s,
        DEFAULT_CONFIG,
        i % 2 ? fail : async () => result(null),
        mail,
        { scheduled: true },
        clock,
      );
    expect(mail).toHaveBeenCalledTimes(1);
    expect(s.state('scheduledFailures')).toBe('5');
    await check(
      s,
      DEFAULT_CONFIG,
      async () => result(1000),
      mail,
      { scheduled: true },
      () => new Date('2026-10-25T16:00:00Z'),
    );
    for (let i = 0; i < 3; i++)
      await check(
        s,
        DEFAULT_CONFIG,
        fail,
        mail,
        { scheduled: true },
        () => new Date('2026-10-26T16:00:00Z'),
      );
    expect(mail).toHaveBeenCalledTimes(2);
  });
  it('skips a scheduled run after a full successful run on the same local day', async () => {
    const s = makeStore();
    const mail = vi.fn(async () => {});
    const source = vi.fn(async () => result(1000));
    await check(s, DEFAULT_CONFIG, source, mail, {}, clock);
    expect(
      (await check(s, DEFAULT_CONFIG, source, mail, { scheduled: true }, clock))
        .status,
    ).toBe('skipped');
    expect(source).toHaveBeenCalledTimes(1);
  });
  it('catches up at load/wake after a missed day and suppresses the next same-day trigger', async () => {
    const s = makeStore();
    const mail = vi.fn(async () => {});
    const source = vi.fn(async () => result(1000));
    await check(s, DEFAULT_CONFIG, source, mail, { scheduled: true }, clock);
    const wake = () => new Date('2026-10-26T22:00:00Z');
    expect(
      (await check(s, DEFAULT_CONFIG, source, mail, { scheduled: true }, wake))
        .status,
    ).toBe('success');
    expect(
      (await check(s, DEFAULT_CONFIG, source, mail, { scheduled: true }, wake))
        .status,
    ).toBe('skipped');
    expect(source).toHaveBeenCalledTimes(2);
  });
  it('persists error name, sanitized message and failing stage for sources and mail', async () => {
    const s = makeStore();
    const mail = vi.fn(async () => {});
    const failure = await check(
      s,
      DEFAULT_CONFIG,
      async () => {
        throw new TypeError(
          'TEST-timeout https://user:TEST-PASS@example.com/path?token=TEST-TOKEN\nCookie: TEST-COOKIE=private; second=TEST-OTHER',
        );
      },
      mail,
      {},
      clock,
    );
    const diagnostic = failure.diagnostics.join(' ');
    expect(diagnostic).toContain('fetch sources: TypeError: TEST-timeout');
    expect(diagnostic).not.toMatch(
      /TEST-PASS|TEST-TOKEN|TEST-COOKIE|TEST-OTHER|example.com/,
    );
    expect(s.runs()[0]).toMatchObject({ diagnostic });
    await check(s, DEFAULT_CONFIG, async () => result(1000), mail, {}, clock);
    mail.mockRejectedValueOnce(
      new Error('TEST-connection refused; smtp_pass=TEST-SMTP'),
    );
    const delivery = await check(
      s,
      DEFAULT_CONFIG,
      async () => result(900),
      mail,
      {},
      clock,
    );
    expect(delivery.diagnostics.join(' ')).toContain(
      'deliver price-drop email: Error: TEST-connection refused',
    );
    expect(delivery.diagnostics.join(' ')).not.toContain('TEST-SMTP');
  });
  it('rejects mismatched/omitted observations without changing lows', async () => {
    const s = makeStore();
    const mail = vi.fn(async () => {});
    expect(
      (
        await check(
          s,
          DEFAULT_CONFIG,
          async () => ({ ...result(100), observations: [] }),
          mail,
          {},
          clock,
        )
      ).status,
    ).toBe('failure');
    expect(s.low(1, 'online')).toBeUndefined();
  });
  it('removal preserves history, cancels queued alerts, and re-add gets a fresh baseline', async () => {
    const s = makeStore();
    const mail = vi.fn(async () => {
      throw new Error('TEST');
    });
    await check(s, DEFAULT_CONFIG, async () => result(1000), mail, {}, clock);
    await check(s, DEFAULT_CONFIG, async () => result(900), mail, {}, clock);
    s.remove(item.itemNumber);
    expect(s.pending()).toEqual([]);
    expect(s.history(1)).toHaveLength(2);
    const added = s.add(item);
    expect(added.id).not.toBe(1);
    expect(s.low(added.id, 'online')).toBeUndefined();
  });
});
