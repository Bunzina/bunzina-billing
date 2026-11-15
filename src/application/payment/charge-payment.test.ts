import { beforeEach, describe, expect, it } from 'bun:test';
import { issueQuote, approveQuote, type Quote } from '@/domain/quote/quote';
import { buildCommand, createConsumerHarness } from '@/test/consumer-harness';
import { PaymentGatewayError } from '@/domain/payment/payment-gateway';
import { createFakePaymentGateway } from '@/test/fake-payment-gateway';
import { createFakePaymentMailer } from '@/test/fake-payment-mailer';
import { createInMemoryMessageStore } from '@/test/in-memory-message-store';
import { createInMemoryPaymentRepository } from '@/test/in-memory-payment-repository';
import { createInMemoryQuoteRepository } from '@/test/in-memory-quote-repository';
import {
  emailFailuresTotal,
  paymentsTotal,
} from '@/infrastructure/observability/metrics';
import { createChargeHandler } from './charge-payment';

const counterValue = async (
  counter: typeof paymentsTotal | typeof emailFailuresTotal,
  labels: Record<string, string>,
) => {
  const { values } = await counter.get();

  return (
    values.find((entry) =>
      Object.entries(labels).every(
        ([key, value]) =>
          (entry.labels as Record<string, unknown>)[key] === value,
      ),
    )?.value ?? 0
  );
};

const NOW = new Date('2026-09-17T14:03:22.115Z');
const SERVICE_ORDER_ID = '0193f2a1-4c7e-7000-8000-0000000000aa';

let quotes: ReturnType<typeof createInMemoryQuoteRepository>;
let payments: ReturnType<typeof createInMemoryPaymentRepository>;
let gateway: ReturnType<typeof createFakePaymentGateway>;
let mailer: ReturnType<typeof createFakePaymentMailer>;
let database: ReturnType<typeof createInMemoryMessageStore>;
let harness: Awaited<ReturnType<typeof createConsumerHarness>>;
let quote: Quote;

const approvedQuote = (): Quote =>
  approveQuote(
    issueQuote({
      serviceOrderId: SERVICE_ORDER_ID,
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
        autoParts: [
          {
            autoPartId: crypto.randomUUID(),
            description: 'Filtro de óleo',
            quantity: 2,
            unitPriceCents: 4500,
          },
        ],
      },
      currency: 'BRL',
      now: NOW,
      validityHours: 72,
    }),
    { approvedBy: '12345678901', now: NOW },
  );

const chargeData = (overrides: Record<string, unknown> = {}) => ({
  serviceOrderId: SERVICE_ORDER_ID,
  quoteId: quote.id,
  totalCents: quote.totalCents,
  currency: 'BRL',
  customer: { ...quote.customer },
  ...overrides,
});

const charge = (overrides: Record<string, unknown> = {}) =>
  buildCommand({
    eventType: 'cmd.billing.charge',
    correlationId: SERVICE_ORDER_ID,
    data: chargeData(overrides),
  });

beforeEach(async () => {
  quotes = createInMemoryQuoteRepository();
  payments = createInMemoryPaymentRepository();
  gateway = createFakePaymentGateway();
  mailer = createFakePaymentMailer();
  database = createInMemoryMessageStore();
  quote = approvedQuote();
  quotes.save(quote);
  harness = await createConsumerHarness(
    {
      'cmd.billing.charge': createChargeHandler({
        quotes,
        payments,
        gateway,
        mailer,
        clock: () => NOW,
        validityMinutes: 30,
        retry: { maxAttempts: 3, baseDelayMs: 0, sleep: async () => {} },
      }),
    },
    database.store,
  );
});

describe('cmd.billing.charge', () => {
  it('creates a pending payment with the checkout link for an approved quote and emails the link', async () => {
    await harness.deliver(charge());

    expect(harness.ack).toHaveBeenCalledTimes(1);

    const [payment] = payments.all();

    expect(payment).toMatchObject({
      quoteId: quote.id,
      serviceOrderId: SERVICE_ORDER_ID,
      status: 'PENDING',
      amountCents: 21000,
      currency: 'BRL',
      providerPaymentId: 'ORDFAKE1',
      checkoutUrl: `https://checkout.fake/${payment?.id}`,
    });
    expect(gateway.calls).toEqual([
      {
        paymentId: payment!.id,
        amountCents: 21000,
        currency: 'BRL',
        description: `Orçamento ${quote.id}`,
        expiresInMinutes: 30,
      },
    ]);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({
      checkoutUrl: payment?.checkoutUrl,
      expiresAt: new Date('2026-09-17T14:33:22.115Z'),
      quote: { id: quote.id, customer: { email: 'maria@example.com' } },
    });
    expect(database.outboxEvents()).toHaveLength(0);
  });

  it.each([
    ['an unknown quote', () => ({ quoteId: crypto.randomUUID() })],
    ['another service order', () => ({ serviceOrderId: crypto.randomUUID() })],
    ['a divergent total', () => ({ totalCents: 20999 })],
    ['a divergent currency', () => ({ currency: 'USD' })],
    ['a zero total', () => ({ totalCents: 0 })],
    ['a malformed payload', () => ({ quoteId: 'not-a-uuid' })],
  ])(
    'sends a command with %s straight to the DLQ without calling the provider',
    async (_label, overrides) => {
      await harness.deliver(charge(overrides()));

      expect(harness.nack).toHaveBeenCalledTimes(1);
      expect(harness.ack).not.toHaveBeenCalled();
      expect(harness.sleep).not.toHaveBeenCalled();
      expect(gateway.calls).toHaveLength(0);
      expect(payments.all()).toHaveLength(0);
      expect(mailer.sent).toHaveLength(0);
    },
  );

  it.each(['ISSUED', 'REJECTED', 'EXPIRED', 'CANCELED'] as const)(
    'sends a charge for a %s quote to the DLQ',
    async (status) => {
      quotes.save({ ...quote, status });

      await harness.deliver(charge());

      expect(harness.nack).toHaveBeenCalledTimes(1);
      expect(gateway.calls).toHaveLength(0);
      expect(payments.all()).toHaveLength(0);
    },
  );

  it('does nothing new when the same command is redelivered', async () => {
    const command = charge();

    await harness.deliver(command);
    await harness.deliver(command);

    expect(harness.ack).toHaveBeenCalledTimes(2);
    expect(payments.all()).toHaveLength(1);
    expect(gateway.calls).toHaveLength(1);
    expect(mailer.sent).toHaveLength(1);
  });

  it('creates no second payment, call or email when a new charge arrives for a quote that already has one', async () => {
    await harness.deliver(charge());
    await harness.deliver(charge());

    expect(harness.ack).toHaveBeenCalledTimes(2);
    expect(payments.all()).toHaveLength(1);
    expect(gateway.calls).toHaveLength(1);
    expect(mailer.sent).toHaveLength(1);
  });

  it('counts the pending payment by status', async () => {
    const before = await counterValue(paymentsTotal, { status: 'PENDING' });

    await harness.deliver(charge());

    expect(await counterValue(paymentsTotal, { status: 'PENDING' })).toBe(
      before + 1,
    );
  });

  describe('when the provider fails', () => {
    const transient = () =>
      new PaymentGatewayError(
        'mercadopago create_order failed',
        true,
        'http_503',
      );

    it('retries a transient error and still creates the payment', async () => {
      gateway.failNext(transient(), transient());

      await harness.deliver(charge());

      expect(gateway.calls).toHaveLength(3);
      expect(payments.all()).toMatchObject([{ status: 'PENDING' }]);
      expect(database.outboxEvents()).toHaveLength(0);
      expect(mailer.sent).toHaveLength(1);
    });

    it('publishes payment-failed with PROVIDER_ERROR once the retries are exhausted', async () => {
      gateway.failNext(transient(), transient(), transient());
      const command = charge();

      await harness.deliver(command);

      expect(harness.ack).toHaveBeenCalledTimes(1);
      expect(gateway.calls).toHaveLength(3);

      const [payment] = payments.all();

      expect(payment).toMatchObject({
        status: 'FAILED',
        failureReason: 'PROVIDER_ERROR',
        amountCents: 21000,
      });
      expect(payment?.checkoutUrl).toBeUndefined();
      expect(database.outboxEvents()).toMatchObject([
        {
          eventType: 'evt.billing.payment-failed',
          correlationId: SERVICE_ORDER_ID,
          causationId: command.eventId,
          data: {
            serviceOrderId: SERVICE_ORDER_ID,
            paymentId: payment?.id,
            quoteId: quote.id,
            reason: 'PROVIDER_ERROR',
            providerStatus: 'http_503',
          },
        },
      ]);
      expect(mailer.sent).toHaveLength(0);
    });

    it('does not retry an error the provider will keep returning', async () => {
      gateway.failNext(
        new PaymentGatewayError(
          'mercadopago create_order failed',
          false,
          'http_400',
        ),
      );

      await harness.deliver(charge());

      expect(gateway.calls).toHaveLength(1);
      expect(payments.all()).toMatchObject([{ status: 'FAILED' }]);
      expect(database.outboxEvents()).toHaveLength(1);
    });

    it('never charges that payment again, only repeats payment-failed', async () => {
      gateway.failNext(transient(), transient(), transient());
      await harness.deliver(charge());

      await harness.deliver(charge());

      expect(gateway.calls).toHaveLength(3);
      expect(payments.all()).toHaveLength(1);
      expect(database.outboxEvents()).toHaveLength(2);
      expect(database.outboxEvents()[1]).toMatchObject({
        eventType: 'evt.billing.payment-failed',
        data: { reason: 'PROVIDER_ERROR', providerStatus: 'http_503' },
      });
    });

    it('never charges again once the payment expired, only repeats payment-failed with EXPIRED', async () => {
      await harness.deliver(charge());
      const [pending] = payments.all();
      payments.save({
        ...pending!,
        status: 'FAILED',
        failureReason: 'EXPIRED',
        failureDetail: 'expired',
      });

      await harness.deliver(charge());

      expect(gateway.calls).toHaveLength(1);
      expect(payments.all()).toHaveLength(1);
      expect(database.outboxEvents()).toMatchObject([
        {
          eventType: 'evt.billing.payment-failed',
          data: {
            paymentId: pending?.id,
            reason: 'EXPIRED',
            detail: 'The payment was not made before the checkout expired',
            providerStatus: 'expired',
          },
        },
      ]);
    });

    it('counts the failed payment by status', async () => {
      gateway.failNext(transient(), transient(), transient());
      const before = await counterValue(paymentsTotal, { status: 'FAILED' });

      await harness.deliver(charge());

      expect(await counterValue(paymentsTotal, { status: 'FAILED' })).toBe(
        before + 1,
      );
    });
  });

  it('still creates the payment when the email cannot be sent, and counts the failure', async () => {
    mailer.failWith(new Error('smtp down'));
    const before = await counterValue(emailFailuresTotal, {
      template: 'payment-link',
    });

    await harness.deliver(charge());

    expect(harness.ack).toHaveBeenCalledTimes(1);
    expect(payments.all()).toMatchObject([{ status: 'PENDING' }]);
    expect(
      await counterValue(emailFailuresTotal, { template: 'payment-link' }),
    ).toBe(before + 1);
  });
});
