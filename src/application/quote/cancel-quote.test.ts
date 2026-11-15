import { beforeEach, describe, expect, it } from 'bun:test';
import { issueQuote, type Quote } from '@/domain/quote/quote';
import { buildCommand, createConsumerHarness } from '@/test/consumer-harness';
import { createInMemoryMessageStore } from '@/test/in-memory-message-store';
import { createInMemoryPaymentReader } from '@/test/in-memory-payment-reader';
import { createInMemoryQuoteRepository } from '@/test/in-memory-quote-repository';
import { createCancelQuoteHandler } from './cancel-quote';

const NOW = new Date('2026-09-17T15:00:00.000Z');

let quotes: ReturnType<typeof createInMemoryQuoteRepository>;
let payments: ReturnType<typeof createInMemoryPaymentReader>;
let database: ReturnType<typeof createInMemoryMessageStore>;
let harness: Awaited<ReturnType<typeof createConsumerHarness>>;
let quote: Quote;

const cancelCommand = (overrides: Record<string, unknown> = {}) =>
  buildCommand({
    eventType: 'cmd.billing.cancel-quote',
    correlationId: quote.serviceOrderId,
    data: {
      serviceOrderId: quote.serviceOrderId,
      quoteId: quote.id,
      reason: 'TIMEOUT',
      detail: 'saga timed out',
      ...overrides,
    },
  });

beforeEach(async () => {
  quotes = createInMemoryQuoteRepository();
  payments = createInMemoryPaymentReader();
  database = createInMemoryMessageStore();
  harness = await createConsumerHarness(
    {
      'cmd.billing.cancel-quote': createCancelQuoteHandler({
        quotes,
        payments,
        clock: () => NOW,
      }),
    },
    database.store,
  );
  quote = issueQuote({
    serviceOrderId: crypto.randomUUID(),
    customer: {
      id: crypto.randomUUID(),
      name: 'Maria Souza',
      document: '12345678901',
      email: 'maria@example.com',
    },
    items: {
      services: [
        {
          serviceId: crypto.randomUUID(),
          description: 'Troca de óleo',
          priceCents: 12000,
        },
      ],
      autoParts: [],
    },
    currency: 'BRL',
    now: new Date('2026-09-17T14:03:22.115Z'),
    validityHours: 72,
  });
  quotes.save(quote);
});

describe('cmd.billing.cancel-quote', () => {
  it.each(['ISSUED', 'APPROVED', 'EXPIRED'] as const)(
    'cancels a %s quote and publishes quote-canceled',
    async (status) => {
      quotes.save({ ...quote, status });
      const command = cancelCommand();

      await harness.deliver(command);

      expect(harness.ack).toHaveBeenCalledTimes(1);
      expect((await quotes.findById(quote.id))?.status).toBe('CANCELED');

      const [event, ...others] = database.pendingEvents();

      expect(others).toHaveLength(0);
      expect(event).toMatchObject({
        eventType: 'evt.billing.quote-canceled',
        correlationId: quote.serviceOrderId,
        causationId: command.eventId,
        data: {
          serviceOrderId: quote.serviceOrderId,
          quoteId: quote.id,
          canceledAt: '2026-09-17T15:00:00.000Z',
        },
      });
    },
  );

  it('has no new effect on an already canceled quote, and re-emits quote-canceled with the original date', async () => {
    quotes.save({
      ...quote,
      status: 'CANCELED',
      canceledAt: new Date('2026-09-17T14:30:00.000Z'),
    });
    const command = cancelCommand();

    await harness.deliver(command);

    expect(harness.ack).toHaveBeenCalledTimes(1);
    expect(await quotes.findById(quote.id)).toMatchObject({
      status: 'CANCELED',
      canceledAt: new Date('2026-09-17T14:30:00.000Z'),
    });

    const [event, ...others] = database.pendingEvents();

    expect(others).toHaveLength(0);
    expect(event).toMatchObject({
      eventType: 'evt.billing.quote-canceled',
      causationId: command.eventId,
      data: {
        quoteId: quote.id,
        canceledAt: '2026-09-17T14:30:00.000Z',
      },
    });
  });

  it('does nothing new when the same command is redelivered', async () => {
    const command = cancelCommand();

    await harness.deliver(command);
    await harness.deliver(command);

    expect(harness.ack).toHaveBeenCalledTimes(2);
    expect(database.outboxEvents()).toHaveLength(1);
  });

  it('sends the command to the DLQ when the payment is already confirmed, leaving the quote untouched', async () => {
    quotes.save({ ...quote, status: 'APPROVED' });
    payments.confirm(quote.id);

    await harness.deliver(cancelCommand());

    expect(harness.nack).toHaveBeenCalledTimes(1);
    expect(harness.ack).not.toHaveBeenCalled();
    expect(harness.sleep).not.toHaveBeenCalled();
    expect((await quotes.findById(quote.id))?.status).toBe('APPROVED');
    expect(database.outboxEvents()).toHaveLength(0);
  });

  it.each(['REJECTED'] as const)(
    'sends the command to the DLQ for a %s quote, which there is nothing to cancel',
    async (status) => {
      quotes.save({ ...quote, status });

      await harness.deliver(cancelCommand());

      expect(harness.nack).toHaveBeenCalledTimes(1);
      expect((await quotes.findById(quote.id))?.status).toBe(status);
      expect(database.outboxEvents()).toHaveLength(0);
    },
  );

  it.each([
    ['an unknown quote', () => ({ quoteId: crypto.randomUUID() })],
    [
      'a quote of another service order',
      () => ({ serviceOrderId: crypto.randomUUID() }),
    ],
    ['a malformed quote id', () => ({ quoteId: 'abc' })],
    ['a missing reason', () => ({ reason: undefined })],
  ])(
    'sends a command with %s straight to the DLQ',
    async (_label, overrides) => {
      await harness.deliver(cancelCommand(overrides()));

      expect(harness.nack).toHaveBeenCalledTimes(1);
      expect(harness.ack).not.toHaveBeenCalled();
      expect(harness.sleep).not.toHaveBeenCalled();
      expect((await quotes.findById(quote.id))?.status).toBe('ISSUED');
      expect(database.outboxEvents()).toHaveLength(0);
    },
  );
});
