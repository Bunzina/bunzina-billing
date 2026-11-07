import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createInMemoryMessageStore } from '@/test/in-memory-message-store';
import { EXCHANGE, QUEUE } from './connection';
import {
  InvalidMessageError,
  startConsumer,
  type MessageHandler,
} from './consumer';
import { buildEnvelope } from './envelope';

const ack = mock(() => {});
const nack = mock(() => {});
const bindQueue = mock(async () => ({}) as never);

let consumeCallback: ((message: unknown) => Promise<void>) | null = null;

const channel = {
  ack,
  nack,
  bindQueue,
  consume: mock(async (_queue: string, callback: never) => {
    consumeCallback = callback as unknown as (
      message: unknown,
    ) => Promise<void>;
    return { consumerTag: 'tag' };
  }),
};

const messageFor = (eventType: string) => {
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

const sleep = mock(async (_ms: number) => {});

const start = async (handlers: Record<string, MessageHandler>) => {
  const database = createInMemoryMessageStore();

  await startConsumer({
    handlers,
    bindings: ['cmd.billing.*'],
    channel: channel as never,
    store: database.store,
    retry: { maxAttempts: 3, baseDelayMs: 100, sleep },
  });

  return database;
};

const deliver = (message: unknown) => consumeCallback?.(message);

beforeEach(() => {
  ack.mockClear();
  nack.mockClear();
  bindQueue.mockClear();
  sleep.mockClear();
  consumeCallback = null;
});

describe('startConsumer', () => {
  it('binds the queue to every requested routing pattern', async () => {
    await start({});

    expect(bindQueue).toHaveBeenCalledWith(QUEUE, EXCHANGE, 'cmd.billing.*');
  });

  it('ignores an empty delivery', async () => {
    await start({});
    await deliver(null);

    expect(ack).not.toHaveBeenCalled();
    expect(nack).not.toHaveBeenCalled();
  });

  it('runs the handler once and acks a first delivery', async () => {
    const handler = mock(async () => {});
    const database = await start({ 'cmd.billing.charge': handler });

    await deliver(messageFor('cmd.billing.charge').message);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(database.processedCount()).toBe(1);
  });

  it('acks a redelivered message without running the handler again', async () => {
    const handler = mock(async () => {});
    await start({ 'cmd.billing.charge': handler });
    const { message } = messageFor('cmd.billing.charge');

    await deliver(message);
    await deliver(message);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledTimes(2);
    expect(nack).not.toHaveBeenCalled();
  });

  it('records the delivery in the same transaction as the handler, so a failed attempt can be retried', async () => {
    let attempts = 0;
    const handler = mock(async () => {
      attempts += 1;

      if (attempts === 1) {
        throw new Error('transient');
      }
    });
    const database = await start({ 'cmd.billing.charge': handler });

    await deliver(messageFor('cmd.billing.charge').message);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(nack).not.toHaveBeenCalled();
    expect(database.processedCount()).toBe(1);
  });

  it('waits with exponential backoff between attempts and dead letters after the last one', async () => {
    const handler = mock(async () => {
      throw new Error('still down');
    });
    const database = await start({ 'cmd.billing.charge': handler });

    await deliver(messageFor('cmd.billing.charge').message);

    expect(handler).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200]);
    expect(nack).toHaveBeenCalledWith(expect.anything(), false, false);
    expect(ack).not.toHaveBeenCalled();
    expect(database.processedCount()).toBe(0);
  });

  it('dead letters without retrying when the handler rejects the message as invalid', async () => {
    const handler = mock(async () => {
      throw new InvalidMessageError('total must be positive');
    });
    await start({ 'cmd.billing.charge': handler });

    await deliver(messageFor('cmd.billing.charge').message);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(nack).toHaveBeenCalledWith(expect.anything(), false, false);
  });

  it('dead letters a message nobody handles without recording it', async () => {
    const database = await start({});

    await deliver(messageFor('cmd.billing.refund').message);

    expect(nack).toHaveBeenCalledWith(expect.anything(), false, false);
    expect(database.processedCount()).toBe(0);
  });

  it('dead letters a message that does not match the envelope without retrying', async () => {
    const handler = mock(async () => {});
    const database = await start({ nope: handler });

    await deliver({
      content: Buffer.from(JSON.stringify({ eventType: 'nope' })),
      properties: { type: 'nope', headers: {} },
    });

    expect(handler).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(nack).toHaveBeenCalledWith(expect.anything(), false, false);
    expect(database.processedCount()).toBe(0);
  });

  it('dead letters a message whose body is not JSON', async () => {
    await start({});

    await deliver({
      content: Buffer.from('not json'),
      properties: { type: 'cmd.billing.charge', headers: {} },
    });

    expect(nack).toHaveBeenCalledWith(expect.anything(), false, false);
  });

  it('queues events emitted by the handler with the correlation and causation of the incoming message', async () => {
    const handler: MessageHandler = async ({ emit }) => {
      await emit('evt.billing.payment-confirmed', { paymentId: 'p-1' });
    };
    const database = await start({ 'cmd.billing.charge': handler });
    const { envelope, message } = messageFor('cmd.billing.charge');

    await deliver(message);

    const [emitted] = database.pendingEvents();

    expect(database.pendingEvents()).toHaveLength(1);
    expect(emitted?.eventType).toBe('evt.billing.payment-confirmed');
    expect(emitted?.correlationId).toBe(envelope.correlationId);
    expect(emitted?.causationId).toBe(envelope.eventId);
    expect(emitted?.data).toEqual({ paymentId: 'p-1' });
  });

  it('drops events emitted by an attempt that failed', async () => {
    const handler: MessageHandler = async ({ emit }) => {
      await emit('evt.billing.payment-confirmed', {});
      throw new Error('after emit');
    };
    const database = await start({ 'cmd.billing.charge': handler });

    await deliver(messageFor('cmd.billing.charge').message);

    expect(database.outboxEvents()).toHaveLength(0);
    expect(nack).toHaveBeenCalled();
  });
});
