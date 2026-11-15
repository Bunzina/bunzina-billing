import { beforeEach, describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import Elysia from 'elysia';
import { createExpirePayments } from '@/application/payment/expire-payments';
import { createHandleNotification } from '@/application/payment/handle-notification';
import { createCancelQuoteHandler } from '@/application/quote/cancel-quote';
import {
  attachCheckout,
  createPendingPayment,
  type Payment,
} from '@/domain/payment/payment';
import { PaymentGatewayError } from '@/domain/payment/payment-gateway';
import { issueQuote, type Quote } from '@/domain/quote/quote';
import { lateRefundsTotal } from '@/infrastructure/observability/metrics';
import { buildCommand, createConsumerHarness } from '@/test/consumer-harness';
import { createFakePaymentGateway } from '@/test/fake-payment-gateway';
import { createInMemoryMessageStore } from '@/test/in-memory-message-store';
import { createInMemoryPaymentEventLog } from '@/test/in-memory-payment-event-log';
import { createInMemoryPaymentRepository } from '@/test/in-memory-payment-repository';
import { createInMemoryQuoteRepository } from '@/test/in-memory-quote-repository';
import { webhookRoutes } from './webhook-routes';

const SECRET = 'webhook-secret';
const NOTIFICATION_ID = '46119445524';
const REQUEST_ID = '12195177-fc55-415a-a716-8318364fa851';
const CREATED_AT = new Date('2026-09-17T14:03:22.115Z');
const PAID_AT = new Date('2026-09-17T14:31:08.000Z');
const REFUNDED_AT = new Date('2026-09-17T14:40:00.000Z');

let quotes: ReturnType<typeof createInMemoryQuoteRepository>;
let payments: ReturnType<typeof createInMemoryPaymentRepository>;
let events: ReturnType<typeof createInMemoryPaymentEventLog>;
let gateway: ReturnType<typeof createFakePaymentGateway>;
let database: ReturnType<typeof createInMemoryMessageStore>;
let harness: Awaited<ReturnType<typeof createConsumerHarness>>;
let app: { handle: (request: Request) => Response | Promise<Response> };
let now: Date;
let quote: Quote;
let pending: Payment;

const lateRefunds = async () => {
  const { values } = await lateRefundsTotal.get();

  return values.reduce((sum, entry) => sum + entry.value, 0);
};

const notify = () => {
  const ts = '1794608203';
  const digest = createHmac('sha256', SECRET)
    .update(`id:${NOTIFICATION_ID};request-id:${REQUEST_ID};ts:${ts};`)
    .digest('hex');

  return app.handle(
    new Request(
      `http://localhost/webhooks/mercadopago?data.id=${NOTIFICATION_ID}&type=topic_merchant_order_wh`,
      {
        method: 'POST',
        headers: {
          'x-request-id': REQUEST_ID,
          'x-signature': `ts=${ts},v1=${digest}`,
        },
        body: '{}',
      },
    ),
  );
};

const cancelQuote = () =>
  harness.deliver(
    buildCommand({
      eventType: 'cmd.billing.cancel-quote',
      correlationId: quote.serviceOrderId,
      data: {
        serviceOrderId: quote.serviceOrderId,
        quoteId: quote.id,
        reason: 'TIMEOUT',
      },
    }),
  );

const expirePayments = () =>
  createExpirePayments({
    payments,
    events,
    gateway,
    store: database.store,
    clock: () => now,
  })();

const customerPays = () =>
  gateway.setOrder('ORDTST01', {
    state: 'PAID',
    method: 'pix',
    paidAt: PAID_AT,
  });

const sagaEventTypes = () =>
  database.outboxEvents().map((event) => event.eventType);

beforeEach(async () => {
  now = REFUNDED_AT;
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
        clock: () => now,
      }),
    },
    database.store,
  );
  app = new Elysia().use(
    webhookRoutes({
      secret: SECRET,
      handleNotification: createHandleNotification({
        payments,
        events,
        gateway,
        store: database.store,
        clock: () => now,
      }),
    }),
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
          priceCents: 21000,
        },
      ],
      autoParts: [],
    },
    currency: 'BRL',
    now: CREATED_AT,
    validityHours: 72,
  });
  quotes.save(quote);
  pending = attachCheckout(
    createPendingPayment({
      quoteId: quote.id,
      serviceOrderId: quote.serviceOrderId,
      amountCents: quote.totalCents,
      currency: quote.currency,
      now: CREATED_AT,
      validityMinutes: 30,
    }),
    { providerPaymentId: 'ORDTST01', checkoutUrl: 'https://checkout.fake/1' },
  );
  payments.save(pending);
  gateway.knowNotification(NOTIFICATION_ID, pending.id);
});

describe('a late payment, after the quote was canceled', () => {
  beforeEach(async () => {
    await cancelQuote();
    customerPays();
  });

  it('is refunded automatically, recorded in payment_events and not published to the saga', async () => {
    const before = await lateRefunds();

    const response = await notify();

    expect(response.status).toBe(200);
    expect(gateway.refunds).toEqual([
      { paymentId: pending.id, providerPaymentId: 'ORDTST01' },
    ]);
    expect(await payments.findById(pending.id)).toMatchObject({
      status: 'FAILED',
      failureReason: 'TIMEOUT',
      providerRefundId: 'REFFAKE1',
      refundedAt: REFUNDED_AT,
    });
    expect(events.all().at(-1)).toEqual({
      paymentId: pending.id,
      type: 'late-payment-refunded',
      payload: { providerRefundId: 'REFFAKE1', failureReason: 'TIMEOUT' },
    });
    expect(sagaEventTypes()).toEqual(['evt.billing.quote-canceled']);
    expect(await lateRefunds()).toBe(before + 1);
  });

  it('is refunded once when the same notification is delivered again', async () => {
    const before = await lateRefunds();

    await notify();
    await notify();

    expect(gateway.refunds).toHaveLength(1);
    expect(events.all().at(-1)?.type).toBe('payment-approval-ignored');
    expect(await lateRefunds()).toBe(before + 1);
  });

  it('answers 502 when the provider cannot refund, and refunds when the notification is redelivered', async () => {
    gateway.failRefunds(new PaymentGatewayError('down', true, 'http_503'));

    const failed = await notify();

    expect(failed.status).toBe(502);
    expect((await payments.findById(pending.id))?.refundedAt).toBeUndefined();

    const retried = await notify();

    expect(retried.status).toBe(200);
    expect((await payments.findById(pending.id))?.refundedAt).toEqual(
      REFUNDED_AT,
    );
  });
});

describe('a late payment, after the checkout expired', () => {
  beforeEach(async () => {
    now = new Date(CREATED_AT.getTime() + 31 * 60 * 1000);
    await expirePayments();
    customerPays();
  });

  it('is refunded automatically without publishing anything beyond the payment-failed already sent', async () => {
    const before = await lateRefunds();

    const response = await notify();

    expect(response.status).toBe(200);
    expect(gateway.refunds).toEqual([
      { paymentId: pending.id, providerPaymentId: 'ORDTST01' },
    ]);
    expect(await payments.findById(pending.id)).toMatchObject({
      status: 'FAILED',
      failureReason: 'EXPIRED',
      providerRefundId: 'REFFAKE1',
      refundedAt: now,
    });
    expect(events.all().at(-1)).toMatchObject({
      type: 'late-payment-refunded',
      payload: { failureReason: 'EXPIRED' },
    });
    expect(sagaEventTypes()).toEqual(['evt.billing.payment-failed']);
    expect(await lateRefunds()).toBe(before + 1);
  });
});
