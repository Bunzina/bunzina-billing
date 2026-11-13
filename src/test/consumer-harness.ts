import { mock } from 'bun:test';
import {
  startConsumer,
  type MessageHandler,
} from '@/infrastructure/messaging/consumer';
import {
  buildEnvelope,
  type Envelope,
} from '@/infrastructure/messaging/envelope';
import type { MessageStore } from '@/infrastructure/messaging/message-store';

type CommandInput = {
  eventType: string;
  data: Record<string, unknown>;
  correlationId?: string;
};

export const buildCommand = ({
  eventType,
  data,
  correlationId = crypto.randomUUID(),
}: CommandInput): Envelope =>
  buildEnvelope({ eventType, correlationId, data }) as Envelope;

export const createConsumerHarness = async (
  handlers: Record<string, MessageHandler>,
  store: MessageStore,
) => {
  const ack = mock(() => {});
  const nack = mock(() => {});
  const sleep = mock(async (_ms: number) => {});
  let consumeCallback: ((message: unknown) => Promise<void>) | null = null;

  const channel = {
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

  await startConsumer({
    handlers,
    bindings: ['cmd.billing.*'],
    channel: channel as never,
    store,
    retry: { maxAttempts: 3, baseDelayMs: 0, sleep },
  });

  return {
    ack,
    nack,
    sleep,
    deliver: async (envelope: Envelope) => {
      await consumeCallback?.({
        content: Buffer.from(JSON.stringify(envelope)),
        properties: { type: envelope.eventType, headers: {} },
      });
    },
  };
};
