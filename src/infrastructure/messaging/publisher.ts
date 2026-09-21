import { context, propagation, SpanKind, trace } from '@opentelemetry/api';
import type { Channel } from 'amqplib';
import { messagesPublishedTotal } from '../observability/metrics';
import { EXCHANGE, getChannel } from './connection';
import type { Envelope } from './envelope';

const tracer = trace.getTracer('messaging');

export const publish = async <TData extends Record<string, unknown>>(
  envelope: Envelope<TData>,
  channelOverride?: Channel,
): Promise<void> => {
  const channel = channelOverride ?? (await getChannel());

  await tracer.startActiveSpan(
    `publish ${envelope.eventType}`,
    { kind: SpanKind.PRODUCER },
    async (span) => {
      try {
        const headers: Record<string, string> = {};
        propagation.inject(context.active(), headers);

        const payload = { ...envelope, traceparent: headers.traceparent };

        channel.publish(
          EXCHANGE,
          envelope.eventType,
          Buffer.from(JSON.stringify(payload)),
          {
            persistent: true,
            messageId: envelope.eventId,
            correlationId: envelope.correlationId,
            type: envelope.eventType,
            contentType: 'application/json',
            headers,
          },
        );

        messagesPublishedTotal.inc({ event_type: envelope.eventType });
      } finally {
        span.end();
      }
    },
  );
};
