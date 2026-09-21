import { describe, expect, it, mock } from 'bun:test';
import { propagation } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import type { Channel } from 'amqplib';
import { buildEnvelope } from './envelope';
import { publish } from './publisher';

propagation.setGlobalPropagator(new W3CTraceContextPropagator());

const fakeChannel = () => {
  const publishMock = mock(() => true);
  return {
    channel: { publish: publishMock } as unknown as Channel,
    publishMock,
  };
};

describe('publish', () => {
  it('uses the event type as the routing key', async () => {
    const { channel, publishMock } = fakeChannel();

    const envelope = buildEnvelope({
      eventType: 'cmd.billing.issue-quote',
      correlationId: crypto.randomUUID(),
      data: {},
    });

    await publish(envelope, channel);

    const [exchange, routingKey] = publishMock.mock.calls[0] ?? [];
    expect(exchange).toBe('bunzina.events');
    expect(routingKey).toBe('cmd.billing.issue-quote');
  });

  it('publishes a persistent message carrying the correlation id', async () => {
    const { channel, publishMock } = fakeChannel();
    const correlationId = crypto.randomUUID();

    await publish(
      buildEnvelope({
        eventType: 'evt.os.order-created',
        correlationId,
        data: {},
      }),
      channel,
    );

    const options = publishMock.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(options.persistent).toBe(true);
    expect(options.correlationId).toBe(correlationId);
  });

  it('carries the envelope through as JSON', async () => {
    const { channel, publishMock } = fakeChannel();

    const envelope = buildEnvelope({
      eventType: 'evt.billing.quote-issued',
      correlationId: crypto.randomUUID(),
      data: { quoteId: 'abc' },
    });

    await publish(envelope, channel);

    const body = publishMock.mock.calls[0]?.[2] as Buffer;
    const decoded = JSON.parse(body.toString());

    expect(decoded.eventId).toBe(envelope.eventId);
    expect(decoded.data.quoteId).toBe('abc');
  });
});
