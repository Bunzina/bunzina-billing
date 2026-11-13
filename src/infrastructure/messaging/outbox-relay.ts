import { context, propagation, ROOT_CONTEXT } from '@opentelemetry/api';
import type { ConfirmChannel } from 'amqplib';
import logger from '@lucas-pmelo/logger';
import { outboxPending } from '../observability/metrics';
import { getChannel } from './connection';
import { type MessageStore, postgresMessageStore } from './message-store';
import { publish } from './publisher';

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_INTERVAL_MS = 1000;

type RelayInput = {
  store?: MessageStore;
  channel?: Pick<ConfirmChannel, 'publish' | 'waitForConfirms'>;
  batchSize?: number;
};

export const relayOnce = async ({
  store = postgresMessageStore,
  channel: channelOverride,
  batchSize = DEFAULT_BATCH_SIZE,
}: RelayInput = {}): Promise<number> => {
  try {
    const channel = channelOverride ?? (await getChannel());

    return await store.transact(async (tx) => {
      const rows = await store.claimPending(tx, batchSize);
      const sent: string[] = [];

      try {
        for (const { envelope } of rows) {
          const parent = envelope.traceparent
            ? propagation.extract(ROOT_CONTEXT, {
                traceparent: envelope.traceparent,
              })
            : ROOT_CONTEXT;

          await context.with(parent, () => publish(envelope, channel));
          sent.push(envelope.eventId);
        }
      } catch (error) {
        logger.error({
          message: 'failed to publish outbox event',
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (sent.length === 0) {
        return 0;
      }

      try {
        await channel.waitForConfirms();
      } catch (error) {
        logger.error({
          message: 'broker did not confirm the outbox batch',
          error: error instanceof Error ? error.message : String(error),
        });
        return 0;
      }

      await store.markPublished(tx, sent);

      return sent.length;
    });
  } finally {
    outboxPending.set(await store.countPending());
  }
};

type StartRelayInput = RelayInput & { intervalMs?: number };

export const startRelay = ({
  intervalMs = DEFAULT_INTERVAL_MS,
  ...input
}: StartRelayInput = {}) => {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  const tick = async () => {
    try {
      await relayOnce(input);
    } catch (error) {
      logger.error({
        message: 'outbox relay round failed',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (!stopped) {
        timer = setTimeout(() => {
          inFlight = tick();
        }, intervalMs);
      }
    }
  };

  inFlight = tick();

  return {
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await inFlight;
    },
  };
};
