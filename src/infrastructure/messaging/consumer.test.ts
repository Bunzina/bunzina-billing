import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { EXCHANGE, QUEUE } from './connection';
import { startConsumer } from './consumer';
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
    consumeCallback = callback as unknown as typeof consumeCallback extends null
      ? never
      : (message: unknown) => Promise<void>;
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

const start = async (overrides: {
  handlers?: Record<string, () => Promise<void>>;
  isFirstDelivery?: () => Promise<boolean>;
}) => {
  await startConsumer({
    handlers: overrides.handlers ?? {},
    isFirstDelivery: overrides.isFirstDelivery ?? (async () => true),
    bindings: ['cmd.billing.*'],
    channel: channel as never,
  });
};

beforeEach(() => {
  ack.mockClear();
  nack.mockClear();
  bindQueue.mockClear();
  consumeCallback = null;
});

describe('startConsumer', () => {
  it('binds the queue to every requested routing pattern', async () => {
    await start({});

    expect(bindQueue).toHaveBeenCalledWith(QUEUE, EXCHANGE, 'cmd.billing.*');
  });

  it('ignores an empty delivery', async () => {
    await start({});
    await consumeCallback?.(null);

    expect(ack).not.toHaveBeenCalled();
    expect(nack).not.toHaveBeenCalled();
  });

  it('runs the handler and acks a first delivery', async () => {
    const handler = mock(async () => {});
    await start({ handlers: { 'cmd.billing.charge': handler } });

    await consumeCallback?.(messageFor('cmd.billing.charge').message);

    expect(handler).toHaveBeenCalled();
    expect(ack).toHaveBeenCalled();
  });

  it('acks without running the handler when the event was already processed', async () => {
    const handler = mock(async () => {});
    await start({
      handlers: { 'cmd.billing.charge': handler },
      isFirstDelivery: async () => false,
    });

    await consumeCallback?.(messageFor('cmd.billing.charge').message);

    expect(handler).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalled();
  });

  it('dead letters a message nobody handles', async () => {
    await start({});

    await consumeCallback?.(messageFor('cmd.billing.refund').message);

    expect(nack).toHaveBeenCalledWith(expect.anything(), false, false);
  });

  it('dead letters a message whose handler threw', async () => {
    await start({
      handlers: {
        'cmd.billing.charge': async () => {
          throw new Error('boom');
        },
      },
    });

    await consumeCallback?.(messageFor('cmd.billing.charge').message);

    expect(nack).toHaveBeenCalledWith(expect.anything(), false, false);
  });

  it('dead letters a message that does not match the envelope', async () => {
    await start({});

    await consumeCallback?.({
      content: Buffer.from(JSON.stringify({ eventType: 'nope' })),
      properties: { type: 'nope', headers: {} },
    });

    expect(nack).toHaveBeenCalledWith(expect.anything(), false, false);
  });
});
