import { beforeEach, describe, expect, it } from 'bun:test';
import {
  attachCheckout,
  createPendingPayment,
  type Payment,
} from '@/domain/payment/payment';
import { PaymentGatewayError } from '@/domain/payment/payment-gateway';
import { issueQuote, type Quote } from '@/domain/quote/quote';
import { paymentsTotal } from '@/infrastructure/observability/metrics';
import { buildCommand, createConsumerHarness } from '@/test/consumer-harness';
import { createInMemoryMessageStore } from '@/test/in-memory-message-store';
import { createInMemoryPaymentEventLog } from '@/test/in-memory-payment-event-log';
import { createInMemoryPaymentRepository } from '@/test/in-memory-payment-repository';
import { createFakePaymentGateway } from '@/test/fake-payment-gateway';
import { createInMemoryQuoteRepository } from '@/test/in-memory-quote-repository';
import { createCancelQuoteHandler } from './cancel-quote';

const NOW = new Date('2026-09-17T15:00:00.000Z');

let quotes: ReturnType<typeof createInMemoryQuoteRepository>;
let payments: ReturnType<typeof createInMemoryPaymentRepository>;
let events: ReturnType<typeof createInMemoryPaymentEventLog>;
let gateway: ReturnType<typeof createFakePaymentGateway>;
let database: ReturnType<typeof createInMemoryMessageStore>;
let harness: Awaited<ReturnType<typeof createConsumerHarness>>;
let quote: Quote;

const counterValue = async (status: string) => {
  const { values } = await paymentsTotal.get();

  return values.find((entry) => entry.labels.status === status)?.value ?? 0;
};

const storePayment = (overrides: Partial<Payment> = {}): Payment => {
  const payment = {
    ...attachCheckout(
      createPendingPayment({
        quoteId: quote.id,
        serviceOrderId: quote.serviceOrderId,
        amountCents: quote.totalCents,
        currency: quote.currency,
        now: NOW,
        validityMinutes: 30,
      }),
      { providerPaymentId: 'ORDTST01', checkoutUrl: 'https://checkout.fake/1' },
    ),
    ...overrides,
  };

  payments.save(payment);

  return payment;
};

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
  payments = createInMemoryPaymentRepository();
  events = createInMemoryPaymentEventLog();
  gateway = createFakePaymentGateway();
  database = createInMemoryMessageStore();
  harness = await createConsumerHarness(
    {
      'cmd.billing.cancel-quote': createCancelQuoteHandler({
        quotes,
        payments,
        events,
        gateway,
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
    storePayment({ status: 'CONFIRMED' });

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

  describe('with a payment still pending', () => {
    beforeEach(() => {
      quotes.save({ ...quote, status: 'APPROVED' });
    });

    it('fails the payment with TIMEOUT, expires the checkout, and publishes only quote-canceled', async () => {
      const payment = storePayment();
      const before = await counterValue('FAILED');

      await harness.deliver(cancelCommand());

      expect(harness.ack).toHaveBeenCalledTimes(1);
      expect((await quotes.findById(quote.id))?.status).toBe('CANCELED');
      expect(await payments.findById(payment.id)).toMatchObject({
        status: 'FAILED',
        failureReason: 'TIMEOUT',
      });
      expect(gateway.expired).toEqual(['ORDTST01']);
      expect(database.outboxEvents()).toMatchObject([
        { eventType: 'evt.billing.quote-canceled' },
      ]);
      expect(events.all()).toMatchObject([
        { paymentId: payment.id, type: 'payment-canceled' },
      ]);
      expect(await counterValue('FAILED')).toBe(before + 1);
    });

    it('still cancels the quote when the checkout cannot be expired, and records the failure', async () => {
      const payment = storePayment();
      gateway.failExpirations(
        new PaymentGatewayError('mercadopago cancel failed', true, 'http_503'),
      );

      await harness.deliver(cancelCommand());

      expect(harness.ack).toHaveBeenCalledTimes(1);
      expect((await quotes.findById(quote.id))?.status).toBe('CANCELED');
      expect((await payments.findById(payment.id))?.status).toBe('FAILED');
      expect(events.all()).toMatchObject([
        { type: 'payment-canceled' },
        {
          paymentId: payment.id,
          type: 'checkout-expiry-failed',
          payload: { providerPaymentId: 'ORDTST01' },
        },
      ]);
    });

    it('still cancels the quote when no payment gateway is configured', async () => {
      const payment = storePayment();
      const unconfigured = await createConsumerHarness(
        {
          'cmd.billing.cancel-quote': createCancelQuoteHandler({
            quotes,
            payments,
            events,
            gateway: undefined,
            clock: () => NOW,
          }),
        },
        database.store,
      );

      await unconfigured.deliver(cancelCommand());

      expect(unconfigured.ack).toHaveBeenCalledTimes(1);
      expect((await quotes.findById(quote.id))?.status).toBe('CANCELED');
      expect((await payments.findById(payment.id))?.status).toBe('FAILED');
      expect(events.all().map((event) => event.type)).toEqual([
        'payment-canceled',
        'checkout-expiry-failed',
      ]);
    });

    it.each(['FAILED', 'REFUNDED'] as const)(
      'leaves a %s payment as it is and does not touch the provider',
      async (status) => {
        const payment = storePayment({ status });

        await harness.deliver(cancelCommand());

        expect((await quotes.findById(quote.id))?.status).toBe('CANCELED');
        expect((await payments.findById(payment.id))?.status).toBe(status);
        expect(gateway.expired).toHaveLength(0);
        expect(events.all()).toHaveLength(0);
      },
    );

    it('does nothing new to the payment when the same command is redelivered', async () => {
      storePayment();
      const command = cancelCommand();

      await harness.deliver(command);
      await harness.deliver(command);

      expect(gateway.expired).toHaveLength(1);
      expect(events.all()).toHaveLength(1);
    });
  });
});
