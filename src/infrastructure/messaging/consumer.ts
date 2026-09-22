import { context, propagation, SpanKind, trace } from '@opentelemetry/api';
import type { Channel, ConsumeMessage } from 'amqplib';
import logger from '@lucas-pmelo/logger';
import {
  messageHandlingDurationSeconds,
  messagesConsumedTotal,
} from '../observability/metrics';
import { EXCHANGE, getChannel, QUEUE } from './connection';
import { type Envelope, parseEnvelope } from './envelope';

const tracer = trace.getTracer('messaging');

export type MessageHandler = (envelope: Envelope) => Promise<void>;

export type IdempotencyGuard = (eventId: string) => Promise<boolean>;

type StartInput = {
  handlers: Record<string, MessageHandler>;
  isFirstDelivery: IdempotencyGuard;
  bindings: string[];
  channel?: Channel;
};

export const startConsumer = async ({
  handlers,
  isFirstDelivery,
  bindings,
  channel: channelOverride,
}: StartInput): Promise<void> => {
  const channel = channelOverride ?? (await getChannel());

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
          const envelope = parseEnvelope(
            JSON.parse(message.content.toString()),
          );

          if (!(await isFirstDelivery(envelope.eventId))) {
            messagesConsumedTotal.inc({
              event_type: eventType,
              result: 'duplicate',
            });
            channel.ack(message);
            return;
          }

          const handler = handlers[envelope.eventType];

          if (!handler) {
            messagesConsumedTotal.inc({
              event_type: eventType,
              result: 'unhandled',
            });
            channel.nack(message, false, false);
            return;
          }

          await handler(envelope);

          messagesConsumedTotal.inc({
            event_type: eventType,
            result: 'success',
          });
          channel.ack(message);
        } catch (error) {
          logger.error({
            message: 'failed to handle message',
            eventType,
            error: error instanceof Error ? error.message : String(error),
          });

          messagesConsumedTotal.inc({
            event_type: eventType,
            result: 'failure',
          });
          channel.nack(message, false, false);
        } finally {
          stopTimer();
          span.end();
        }
      },
    );
  }
};
