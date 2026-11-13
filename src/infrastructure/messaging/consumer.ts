import { context, propagation, SpanKind, trace } from '@opentelemetry/api';
import type { Channel, ConsumeMessage } from 'amqplib';
import logger from '@lucas-pmelo/logger';
import {
  messageHandlingDurationSeconds,
  messagesConsumedTotal,
} from '../observability/metrics';
import { EXCHANGE, getChannel, QUEUE } from './connection';
import { buildEnvelope, type Envelope, parseEnvelope } from './envelope';
import {
  type MessageStore,
  postgresMessageStore,
  type Tx,
} from './message-store';

const tracer = trace.getTracer('messaging');

export class InvalidMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMessageError';
  }
}

export type AfterCommitWork = () => Promise<void>;

export type HandlerContext = {
  envelope: Envelope;
  tx: Tx;
  afterCommit: (work: AfterCommitWork) => void;
  emit: (eventType: string, data: Record<string, unknown>) => Promise<void>;
};

export type MessageHandler = (context: HandlerContext) => Promise<void>;

export type RetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  sleep: (ms: number) => Promise<void>;
};

const defaultRetry: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: Number(process.env.CONSUMER_RETRY_BASE_MS ?? 200),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

type StartInput = {
  handlers: Record<string, MessageHandler>;
  bindings: string[];
  channel?: Channel;
  store?: MessageStore;
  retry?: Partial<RetryPolicy>;
};

export const startConsumer = async ({
  handlers,
  bindings,
  channel: channelOverride,
  store = postgresMessageStore,
  retry,
}: StartInput): Promise<void> => {
  const channel = channelOverride ?? (await getChannel());
  const policy: RetryPolicy = { ...defaultRetry, ...retry };

  for (const binding of bindings) {
    await channel.bindQueue(QUEUE, EXCHANGE, binding);
  }

  await channel.consume(QUEUE, async (message) => {
    if (!message) {
      return;
    }

    const parentContext = propagation.extract(
      context.active(),
      message.properties.headers ?? {},
    );

    await context.with(parentContext, () => handle(message));
  });

  const deadLetter = (
    message: ConsumeMessage,
    eventType: string,
    result: string,
  ) => {
    messagesConsumedTotal.inc({ event_type: eventType, result });
    channel.nack(message, false, false);
  };

  type Processed = {
    outcome: 'processed' | 'duplicate';
    afterCommit: AfterCommitWork[];
  };

  const runAfterCommit = async (
    work: AfterCommitWork[],
    eventType: string,
  ): Promise<void> => {
    for (const run of work) {
      try {
        await run();
      } catch (error) {
        logger.error({
          message: 'after-commit work failed',
          eventType,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const processEnvelope = (
    envelope: Envelope,
    handler: MessageHandler,
  ): Promise<Processed> =>
    store.transact(async (tx) => {
      const afterCommit: AfterCommitWork[] = [];

      if (!(await store.claimEvent(tx, envelope.eventId, QUEUE))) {
        return { outcome: 'duplicate', afterCommit };
      }

      await handler({
        envelope,
        tx,
        afterCommit: (work) => {
          afterCommit.push(work);
        },
        emit: (eventType, data) =>
          store.enqueue(
            tx,
            buildEnvelope({
              eventType,
              correlationId: envelope.correlationId,
              causationId: envelope.eventId,
              data,
            }),
          ),
      });

      return { outcome: 'processed', afterCommit };
    });

  async function handle(message: ConsumeMessage): Promise<void> {
    const eventType = String(message.properties.type ?? 'unknown');

    await tracer.startActiveSpan(
      `consume ${eventType}`,
      { kind: SpanKind.CONSUMER },
      async (span) => {
        const stopTimer = messageHandlingDurationSeconds.startTimer({
          event_type: eventType,
        });

        try {
          let envelope: Envelope;

          try {
            envelope = parseEnvelope(JSON.parse(message.content.toString()));
          } catch (error) {
            logger.warn({
              message: 'invalid envelope',
              eventType,
              error: error instanceof Error ? error.message : String(error),
            });
            deadLetter(message, eventType, 'invalid');
            return;
          }

          const handler = handlers[envelope.eventType];

          if (!handler) {
            deadLetter(message, eventType, 'unhandled');
            return;
          }

          for (let attempt = 1; ; attempt += 1) {
            try {
              const { outcome, afterCommit } = await processEnvelope(
                envelope,
                handler,
              );

              messagesConsumedTotal.inc({
                event_type: eventType,
                result: outcome === 'duplicate' ? 'duplicate' : 'success',
              });
              channel.ack(message);
              await runAfterCommit(afterCommit, eventType);
              return;
            } catch (error) {
              const reason =
                error instanceof Error ? error.message : String(error);

              if (error instanceof InvalidMessageError) {
                logger.warn({
                  message: 'handler rejected the message',
                  eventType,
                  error: reason,
                });
                deadLetter(message, eventType, 'invalid');
                return;
              }

              if (attempt >= policy.maxAttempts) {
                logger.error({
                  message: 'failed to handle message',
                  eventType,
                  attempts: attempt,
                  error: reason,
                });
                deadLetter(message, eventType, 'failure');
                return;
              }

              messagesConsumedTotal.inc({
                event_type: eventType,
                result: 'retry',
              });
              await policy.sleep(policy.baseDelayMs * 2 ** (attempt - 1));
            }
          }
        } finally {
          stopTimer();
          span.end();
        }
      },
    );
  }
};
