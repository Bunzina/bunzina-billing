import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  applyMigrations,
  countRows,
  db,
  hasIntegrationDatabase,
  resetMessagingTables,
} from '@/test/integration-database';
import {
  startConsumer,
  InvalidMessageError,
  type MessageHandler,
} from './consumer';
import { buildEnvelope, type Envelope } from './envelope';
import { postgresMessageStore } from './message-store';
import { relayOnce } from './outbox-relay';

const ack = mock(() => {});
const nack = mock(() => {});

let consumeCallback: ((message: unknown) => Promise<void>) | null = null;

const consumerChannel = {
  ack,
  nack,
  bindQueue: mock(async () => ({}) as never),
  consume: mock(async (_queue: string, callback: never) => {
    consumeCallback = callback as unknown as (
      message: unknown,
    ) => Promise<void>;
    return { consumerTag: 'tag' };
  }),
};

const messageFor = (eventType = 'cmd.billing.charge') => {
  const envelope = buildEnvelope({
    eventType,
    correlationId: crypto.randomUUID(),
    data: {},
  });

  return {
    envelope,
    message: {
      content: Buffer.from(JSON.stringify(envelope)),
      properties: { type: eventType, headers: {} },
    },
  };
};

const recordBusinessEffect: MessageHandler = async ({ tx, envelope }) => {
  await tx`
    INSERT INTO bunzina.payment_events (id, event_type, payload)
    VALUES (${crypto.randomUUID()}, ${envelope.eventType}, ${'{}'}::jsonb)
  `;
};

const startWith = async (handler: MessageHandler) => {
  await startConsumer({
    handlers: { 'cmd.billing.charge': handler },
    bindings: ['cmd.billing.*'],
    channel: consumerChannel as never,
    retry: { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} },
  });
};

const deliver = (message: unknown) => consumeCallback?.(message);

const brokerChannel = (
  waitForConfirms: () => Promise<void> = async () => {},
) => {
  const published: Envelope[] = [];

  return {
    published,
    channel: {
      publish: (_exchange: string, _key: string, content: Buffer) => {
        published.push(JSON.parse(content.toString()));
        return true;
      },
      waitForConfirms,
    } as never,
  };
};

const seedOutbox = async (count: number) => {
  await postgresMessageStore.transact(async (tx) => {
    for (let index = 0; index < count; index += 1) {
      await postgresMessageStore.enqueue(
        tx,
        buildEnvelope({
          eventType: 'evt.billing.quote-issued',
          correlationId: crypto.randomUUID(),
          data: { index },
        }),
      );
    }
  });
};

describe.skipIf(!hasIntegrationDatabase)('messaging against Postgres', () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await resetMessagingTables();
    ack.mockClear();
    nack.mockClear();
    consumeCallback = null;
  });

  describe('consumer', () => {
    it('processes a message once and acks it', async () => {
      await startWith(recordBusinessEffect);

      await deliver(messageFor().message);

      expect(await countRows('bunzina.payment_events')).toBe(1);
      expect(await countRows('bunzina.processed_events')).toBe(1);
      expect(ack).toHaveBeenCalledTimes(1);
    });

    it('has no effect when the same message is redelivered', async () => {
      await startWith(recordBusinessEffect);
      const { message } = messageFor();

      await deliver(message);
      await deliver(message);

      expect(await countRows('bunzina.payment_events')).toBe(1);
      expect(ack).toHaveBeenCalledTimes(2);
      expect(nack).not.toHaveBeenCalled();
    });

    it('has no effect when the same message is delivered twice at the same time', async () => {
      await startWith(recordBusinessEffect);
      const { message } = messageFor();

      await Promise.all([deliver(message), deliver(message)]);

      expect(await countRows('bunzina.payment_events')).toBe(1);
      expect(await countRows('bunzina.processed_events')).toBe(1);
      expect(ack).toHaveBeenCalledTimes(2);
    });

    it('rolls back the business write and the delivery record when the handler fails, then succeeds on retry', async () => {
      let attempts = 0;
      await startWith(async (context) => {
        await recordBusinessEffect(context);
        attempts += 1;

        if (attempts === 1) {
          throw new Error('transient');
        }
      });

      await deliver(messageFor().message);

      expect(attempts).toBe(2);
      expect(await countRows('bunzina.payment_events')).toBe(1);
      expect(await countRows('bunzina.processed_events')).toBe(1);
      expect(ack).toHaveBeenCalledTimes(1);
    });

    it('dead letters after three failed attempts and leaves nothing behind', async () => {
      let attempts = 0;
      await startWith(async (context) => {
        await recordBusinessEffect(context);
        attempts += 1;
        throw new Error('still down');
      });

      await deliver(messageFor().message);

      expect(attempts).toBe(3);
      expect(nack).toHaveBeenCalledWith(expect.anything(), false, false);
      expect(await countRows('bunzina.payment_events')).toBe(0);
      expect(await countRows('bunzina.processed_events')).toBe(0);
    });

    it('dead letters an invalid message without retrying', async () => {
      let attempts = 0;
      await startWith(async () => {
        attempts += 1;
        throw new InvalidMessageError('total must be positive');
      });

      await deliver(messageFor().message);

      expect(attempts).toBe(1);
      expect(nack).toHaveBeenCalledWith(expect.anything(), false, false);
    });

    it('stores emitted events in the outbox in the same transaction as the business write', async () => {
      await startWith(async (context) => {
        await recordBusinessEffect(context);
        await context.emit('evt.billing.payment-confirmed', { paymentId: 'p' });
      });
      const { envelope, message } = messageFor();

      await deliver(message);

      const rows = await db`
        SELECT event_type, correlation_id, payload
        FROM bunzina.outbox_messages
      `;

      expect(rows).toHaveLength(1);
      expect(rows[0]?.event_type).toBe('evt.billing.payment-confirmed');
      expect(rows[0]?.correlation_id).toBe(envelope.correlationId);
      expect(rows[0]?.payload.causationId).toBe(envelope.eventId);
    });

    it('stores no event when the attempt that emitted it fails', async () => {
      await startWith(async (context) => {
        await context.emit('evt.billing.payment-confirmed', {});
        throw new Error('after emit');
      });

      await deliver(messageFor().message);

      expect(await countRows('bunzina.outbox_messages')).toBe(0);
    });
  });

  describe('outbox relay', () => {
    it('publishes pending events and marks them published', async () => {
      await seedOutbox(3);
      const { channel, published } = brokerChannel();

      const count = await relayOnce({ channel });

      expect(count).toBe(3);
      expect(published).toHaveLength(3);
      expect(await postgresMessageStore.countPending()).toBe(0);
    });

    it('keeps events pending when the broker does not confirm', async () => {
      await seedOutbox(2);
      const { channel } = brokerChannel(async () => {
        throw new Error('nack from broker');
      });

      await relayOnce({ channel });

      expect(await postgresMessageStore.countPending()).toBe(2);
    });

    it('never publishes an event twice when two instances run at the same time', async () => {
      await seedOutbox(10);

      let arrived = 0;
      let release: () => void = () => {};
      const bothHoldingLocks = new Promise<void>((resolve) => {
        release = resolve;
      });
      const waitForBoth = async () => {
        arrived += 1;

        if (arrived === 2) {
          release();
        }

        await bothHoldingLocks;
      };

      const first = brokerChannel(waitForBoth);
      const second = brokerChannel(waitForBoth);

      await Promise.all([
        relayOnce({ channel: first.channel, batchSize: 5 }),
        relayOnce({ channel: second.channel, batchSize: 5 }),
      ]);

      const ids = [...first.published, ...second.published].map(
        (event) => event.eventId,
      );

      expect(first.published).toHaveLength(5);
      expect(second.published).toHaveLength(5);
      expect(new Set(ids).size).toBe(10);
      expect(await postgresMessageStore.countPending()).toBe(0);
    }, 15000);
  });
});
