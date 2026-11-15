import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createChargeHandler } from '@/application/payment/charge-payment';
import { attachCheckout, createPendingPayment } from '@/domain/payment/payment';
import { PaymentGatewayError } from '@/domain/payment/payment-gateway';
import { approveQuote, issueQuote, type Quote } from '@/domain/quote/quote';
import { startConsumer } from '@/infrastructure/messaging/consumer';
import { buildEnvelope } from '@/infrastructure/messaging/envelope';
import { postgresMessageStore } from '@/infrastructure/messaging/message-store';
import {
  applyMigrations,
  countRows,
  db,
  resetQuoteTables,
} from '@/test/integration-database';
import { createFakePaymentGateway } from '@/test/fake-payment-gateway';
import { createFakePaymentMailer } from '@/test/fake-payment-mailer';
import { postgresPaymentRepository } from './postgres-payment-repository';
import { postgresQuoteRepository } from './postgres-quote-repository';

const NOW = new Date('2026-09-17T14:03:22.115Z');

const ack = mock(() => {});
const nack = mock(() => {});

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

const gateway = createFakePaymentGateway();

const startCharging = () =>
  startConsumer({
    handlers: {
      'cmd.billing.charge': createChargeHandler({
        quotes: postgresQuoteRepository,
        payments: postgresPaymentRepository,
        gateway,
        mailer: createFakePaymentMailer(),
        clock: () => NOW,
        validityMinutes: 30,
        retry: { maxAttempts: 2, baseDelayMs: 0, sleep: async () => {} },
      }),
    },
    bindings: ['cmd.billing.*'],
    channel: channel as never,
    retry: { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} },
  });

const storeApprovedQuote = async (): Promise<Quote> => {
  const quote = approveQuote(
    issueQuote({
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
      now: NOW,
      validityHours: 72,
    }),
    { approvedBy: '12345678901', now: NOW },
  );

  await postgresMessageStore.transact((tx) =>
    postgresQuoteRepository.insert(tx, quote),
  );
  await db`UPDATE bunzina.quotes SET status = 'APPROVED' WHERE id = ${quote.id}`;

  return { ...quote, status: 'APPROVED' };
};

const chargeMessage = (quote: Quote) => {
  const envelope = buildEnvelope({
    eventType: 'cmd.billing.charge',
    correlationId: quote.serviceOrderId,
    data: {
      serviceOrderId: quote.serviceOrderId,
      quoteId: quote.id,
      totalCents: quote.totalCents,
      currency: quote.currency,
      customer: quote.customer,
    },
  });

  return {
    properties: { type: envelope.eventType, headers: {} },
    content: Buffer.from(JSON.stringify(envelope)),
  };
};

const newPayment = (quote: Quote) =>
  attachCheckout(
    createPendingPayment({
      quoteId: quote.id,
      serviceOrderId: quote.serviceOrderId,
      amountCents: quote.totalCents,
      currency: quote.currency,
      now: NOW,
      validityMinutes: 30,
    }),
    {
      providerPaymentId: `ORD${crypto.randomUUID()}`,
      checkoutUrl: 'https://x',
    },
  );

describe('payments against Postgres', () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await resetQuoteTables();
    ack.mockClear();
    nack.mockClear();
    consumeCallback = null;
    gateway.calls.length = 0;
  });

  it('stores one pending payment per quote and refuses a second one', async () => {
    const quote = await storeApprovedQuote();

    await postgresMessageStore.transact((tx) =>
      postgresPaymentRepository.insert(tx, newPayment(quote)),
    );

    await expect(
      postgresMessageStore.transact((tx) =>
        postgresPaymentRepository.insert(tx, newPayment(quote)),
      ),
    ).rejects.toThrow();

    expect(await countRows('bunzina.payments')).toBe(1);
  });

  it('stores the payment and the processed marker for a charge, and nothing twice for a repeated charge', async () => {
    await startCharging();
    const quote = await storeApprovedQuote();

    await consumeCallback?.(chargeMessage(quote));
    await consumeCallback?.(chargeMessage(quote));

    const stored = await postgresPaymentRepository.findByQuoteId(quote.id);

    expect(ack).toHaveBeenCalledTimes(2);
    expect(stored).toMatchObject({
      status: 'PENDING',
      amountCents: 12000,
      currency: 'BRL',
      provider: 'mercadopago',
      providerPaymentId: 'ORDFAKE1',
    });
    expect(gateway.calls).toHaveLength(1);
    expect(await countRows('bunzina.payments')).toBe(1);
    expect(await countRows('bunzina.processed_events')).toBe(2);
    expect(await countRows('bunzina.outbox_messages')).toBe(0);
  });

  it('stores a failed payment and its payment-failed event together when the provider keeps failing', async () => {
    await startCharging();
    const quote = await storeApprovedQuote();
    gateway.failNext(
      new PaymentGatewayError('boom', true, 'http_503'),
      new PaymentGatewayError('boom', true, 'http_503'),
    );

    await consumeCallback?.(chargeMessage(quote));

    const stored = await postgresPaymentRepository.findByQuoteId(quote.id);
    const [event] = await db`SELECT payload FROM bunzina.outbox_messages`;

    expect(stored).toMatchObject({
      status: 'FAILED',
      failureReason: 'PROVIDER_ERROR',
      failureDetail: 'http_503',
    });
    expect(event?.payload).toMatchObject({
      eventType: 'evt.billing.payment-failed',
      data: { paymentId: stored?.id, reason: 'PROVIDER_ERROR' },
    });
  });
});
