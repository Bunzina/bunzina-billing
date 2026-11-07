import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { context, propagation } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { createInMemoryMessageStore } from '@/test/in-memory-message-store';
import { getMetrics } from '../observability/metrics';
import { buildEnvelope, type Envelope } from './envelope';
import { relayOnce, startRelay } from './outbox-relay';

propagation.setGlobalPropagator(new W3CTraceContextPropagator());
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

const eventOf = (overrides: Partial<Envelope> = {}): Envelope => ({
  ...buildEnvelope({
    eventType: 'evt.billing.quote-issued',
    correlationId: crypto.randomUUID(),
    data: {},
  }),
  ...overrides,
});

const seed = async (
  database: ReturnType<typeof createInMemoryMessageStore>,
  envelopes: Envelope[],
) => {
  await database.store.transact(async (tx) => {
    for (const envelope of envelopes) {
      await database.store.enqueue(tx, envelope);
    }
  });
};

const fakeChannel = () => {
  const published: { routingKey: string; body: Envelope; headers: unknown }[] =
    [];
  const waitForConfirms = mock(async () => {});

  return {
    published,
    waitForConfirms,
    channel: {
      publish: mock(
        (
          _exchange: string,
          routingKey: string,
          content: Buffer,
          options: { headers: unknown },
        ) => {
          published.push({
            routingKey,
            body: JSON.parse(content.toString()),
            headers: options.headers,
          });
          return true;
        },
      ),
      waitForConfirms,
    } as never,
  };
};

const pendingGauge = async () => {
  const metrics = await getMetrics();
  const line = metrics
    .split('\n')
    .find((entry) => entry.startsWith('billing_outbox_pending '));

  return Number(line?.split(' ')[1]);
};

beforeEach(() => {
  mock.clearAllMocks();
});

describe('relayOnce', () => {
  it('publishes pending events by event type and marks them published', async () => {
    const database = createInMemoryMessageStore();
    const first = eventOf();
    const second = eventOf({ eventType: 'evt.billing.quote-approved' });
    await seed(database, [first, second]);
    const { channel, published } = fakeChannel();

    const count = await relayOnce({ store: database.store, channel });

    expect(count).toBe(2);
    expect(published.map((entry) => entry.routingKey)).toEqual([
      'evt.billing.quote-issued',
      'evt.billing.quote-approved',
    ]);
    expect(database.pendingEvents()).toHaveLength(0);
  });

  it('does not publish an event twice', async () => {
    const database = createInMemoryMessageStore();
    await seed(database, [eventOf()]);
    const { channel, published } = fakeChannel();

    await relayOnce({ store: database.store, channel });
    await relayOnce({ store: database.store, channel });

    expect(published).toHaveLength(1);
  });

  it('keeps the correlation, causation and trace of the stored event', async () => {
    const database = createInMemoryMessageStore();
    const causationId = crypto.randomUUID();
    const event = eventOf({ causationId, traceparent: TRACEPARENT });
    await seed(database, [event]);
    const { channel, published } = fakeChannel();

    await relayOnce({ store: database.store, channel });

    const [entry] = published;
    expect(entry?.body.correlationId).toBe(event.correlationId);
    expect(entry?.body.causationId).toBe(causationId);
    expect(entry?.body.traceparent).toBe(TRACEPARENT);
    const headers = entry?.headers as { traceparent?: string } | undefined;
    expect(headers?.traceparent).toBe(TRACEPARENT);
  });

  it('only marks events as published after the broker confirms them', async () => {
    const database = createInMemoryMessageStore();
    await seed(database, [eventOf(), eventOf()]);
    const { channel, waitForConfirms } = fakeChannel();
    waitForConfirms.mockRejectedValueOnce(new Error('nack from broker'));

    const count = await relayOnce({ store: database.store, channel });

    expect(count).toBe(0);
    expect(database.pendingEvents()).toHaveLength(2);

    await relayOnce({ store: database.store, channel });

    expect(database.pendingEvents()).toHaveLength(0);
  });

  it('respects the batch size', async () => {
    const database = createInMemoryMessageStore();
    await seed(database, [eventOf(), eventOf(), eventOf()]);
    const { channel, published } = fakeChannel();

    await relayOnce({ store: database.store, channel, batchSize: 2 });

    expect(published).toHaveLength(2);
    expect(database.pendingEvents()).toHaveLength(1);
  });

  it('keeps what was confirmed and leaves the rest pending when a publish fails midway', async () => {
    const database = createInMemoryMessageStore();
    await seed(database, [eventOf(), eventOf(), eventOf()]);
    const { channel, published } = fakeChannel();
    let calls = 0;
    (channel as { publish: (...args: unknown[]) => boolean }).publish = (
      ...args: unknown[]
    ) => {
      calls += 1;

      if (calls === 2) {
        throw new Error('channel closed');
      }

      published.push({
        routingKey: String(args[1]),
        body: JSON.parse((args[2] as Buffer).toString()),
        headers: {},
      });
      return true;
    };

    const count = await relayOnce({ store: database.store, channel });

    expect(count).toBe(1);
    expect(database.pendingEvents()).toHaveLength(2);
  });

  it('lets two relays run together without publishing any event twice', async () => {
    const database = createInMemoryMessageStore();
    await seed(database, [eventOf(), eventOf(), eventOf(), eventOf()]);
    const { channel, published } = fakeChannel();

    await Promise.all([
      relayOnce({ store: database.store, channel, batchSize: 2 }),
      relayOnce({ store: database.store, channel, batchSize: 2 }),
    ]);

    const ids = published.map((entry) => entry.body.eventId);

    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    expect(database.pendingEvents()).toHaveLength(0);
  });

  it('still reports the pending count when the broker is unreachable', async () => {
    const database = createInMemoryMessageStore();
    await seed(database, [eventOf(), eventOf()]);
    delete process.env.RABBITMQ_URL;

    await expect(relayOnce({ store: database.store })).rejects.toThrow(
      'RABBITMQ_URL is required',
    );

    expect(await pendingGauge()).toBe(2);
  });

  it('reports how many events are still pending', async () => {
    const database = createInMemoryMessageStore();
    await seed(database, [eventOf(), eventOf(), eventOf()]);
    const { channel } = fakeChannel();

    await relayOnce({ store: database.store, channel, batchSize: 2 });

    expect(await pendingGauge()).toBe(1);
  });
});

describe('startRelay', () => {
  it('polls the outbox and stops when asked', async () => {
    const database = createInMemoryMessageStore();
    const { channel, published } = fakeChannel();

    const relay = startRelay({
      store: database.store,
      channel,
      intervalMs: 5,
    });

    await seed(database, [eventOf()]);
    await Bun.sleep(60);

    expect(published).toHaveLength(1);

    await relay.stop();
    await seed(database, [eventOf()]);
    await Bun.sleep(40);

    expect(published).toHaveLength(1);
  });

  it('keeps polling after a failed round', async () => {
    const database = createInMemoryMessageStore();
    const { channel, published } = fakeChannel();
    const failingStore = {
      ...database.store,
      claimPending: mock(async () => {
        throw new Error('database down');
      }),
    };

    await seed(database, [eventOf()]);
    const relay = startRelay({
      store: failingStore,
      channel,
      intervalMs: 5,
    });
    await Bun.sleep(30);
    await relay.stop();

    expect(failingStore.claimPending.mock.calls.length).toBeGreaterThan(1);
    expect(published).toHaveLength(0);
  });
});
