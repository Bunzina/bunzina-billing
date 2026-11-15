import { beforeEach, describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import Elysia from 'elysia';
import {
  attachCheckout,
  createPendingPayment,
  type Payment,
} from '@/domain/payment/payment';
import { PaymentGatewayError } from '@/domain/payment/payment-gateway';
import { createHandleNotification } from '@/application/payment/handle-notification';
import { createFakePaymentGateway } from '@/test/fake-payment-gateway';
import { createInMemoryMessageStore } from '@/test/in-memory-message-store';
import { createInMemoryPaymentEventLog } from '@/test/in-memory-payment-event-log';
import { createInMemoryPaymentRepository } from '@/test/in-memory-payment-repository';
import { webhookRoutes } from './webhook-routes';

const SECRET = 'webhook-secret';
const NOTIFICATION_ID = '46119445524';
const REQUEST_ID = '12195177-fc55-415a-a716-8318364fa851';

let gateway: ReturnType<typeof createFakePaymentGateway>;
let payments: ReturnType<typeof createInMemoryPaymentRepository>;
let events: ReturnType<typeof createInMemoryPaymentEventLog>;
let database: ReturnType<typeof createInMemoryMessageStore>;
let pending: Payment;
let app: { handle: (request: Request) => Response | Promise<Response> };

const signature = (secret: string, id: string, requestId: string, ts: string) =>
  `ts=${ts},v1=${createHmac('sha256', secret)
    .update(`id:${id};request-id:${requestId};ts:${ts};`)
    .digest('hex')}`;

const notify = (
  overrides: { signature?: string; id?: string; body?: string } = {},
) =>
  app.handle(
    new Request(
      `http://localhost/webhooks/mercadopago?data.id=${overrides.id ?? NOTIFICATION_ID}&type=topic_merchant_order_wh`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-request-id': REQUEST_ID,
          'x-signature':
            overrides.signature ??
            signature(
              SECRET,
              overrides.id ?? NOTIFICATION_ID,
              REQUEST_ID,
              '1794608203',
            ),
        },
        body:
          overrides.body ??
          JSON.stringify({ action: 'update', status: 'closed' }),
      },
    ),
  );

beforeEach(() => {
  gateway = createFakePaymentGateway();
  payments = createInMemoryPaymentRepository();
  events = createInMemoryPaymentEventLog();
  database = createInMemoryMessageStore();
  app = new Elysia().use(
    webhookRoutes({
      secret: SECRET,
      handleNotification: createHandleNotification({
        payments,
        events,
        gateway,
        store: database.store,
      }),
    }),
  );
});

const PAID_AT = new Date('2026-09-17T14:31:08.000Z');

const stagePendingPayment = () => {
  pending = attachCheckout(
    createPendingPayment({
      quoteId: crypto.randomUUID(),
      serviceOrderId: crypto.randomUUID(),
      amountCents: 21000,
      currency: 'BRL',
      now: new Date('2026-09-17T14:03:22.115Z'),
      validityMinutes: 30,
    }),
    { providerPaymentId: 'ORDTST01', checkoutUrl: 'https://checkout.fake/x' },
  );
  payments.save(pending);
  gateway.knowNotification(NOTIFICATION_ID, pending.id);
};

describe('POST /webhooks/mercadopago', () => {
  it('rejects a notification without a valid signature and still records the attempt', async () => {
    const forged = await notify({
      signature: signature(
        'other-secret',
        NOTIFICATION_ID,
        REQUEST_ID,
        '1794608203',
      ),
    });
    const missing = await app.handle(
      new Request(
        `http://localhost/webhooks/mercadopago?data.id=${NOTIFICATION_ID}`,
        {
          method: 'POST',
          body: '{}',
        },
      ),
    );

    expect(forged.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(events.all().map((event) => event.type)).toEqual([
      'webhook-rejected',
      'webhook-rejected',
    ]);
    expect(gateway.lookups).toEqual([]);
    expect(database.pendingEvents()).toEqual([]);
  });
});

describe('POST /webhooks/mercadopago recording', () => {
  it('keeps only the start of an oversized body from an unauthenticated caller', async () => {
    const response = await notify({
      signature: 'ts=1,v1=00',
      body: 'x'.repeat(100_000),
    });

    const [event] = events.all();
    expect(response.status).toBe(401);
    expect(JSON.stringify(event?.payload).length).toBeLessThan(10_000);
  });
});

describe('POST /webhooks/mercadopago for an approved payment', () => {
  beforeEach(stagePendingPayment);

  it('confirms the pending payment from the provider state and publishes payment-confirmed once', async () => {
    gateway.setOrder('ORDTST01', {
      state: 'PAID',
      method: 'pix',
      paidAt: PAID_AT,
    });

    const response = await notify({
      body: JSON.stringify({ status: 'closed', paid: 'ignored-body-claim' }),
    });

    expect(response.status).toBe(200);
    expect(payments.all()[0]).toMatchObject({
      status: 'CONFIRMED',
      method: 'pix',
      paidAt: PAID_AT,
    });
    expect(database.pendingEvents()).toHaveLength(1);
    expect(database.pendingEvents()[0]).toMatchObject({
      eventType: 'evt.billing.payment-confirmed',
      correlationId: pending.serviceOrderId,
      data: {
        serviceOrderId: pending.serviceOrderId,
        paymentId: pending.id,
        quoteId: pending.quoteId,
        provider: 'mercadopago',
        providerPaymentId: 'ORDTST01',
        amountCents: 21000,
        currency: 'BRL',
        method: 'pix',
        paidAt: '2026-09-17T14:31:08.000Z',
      },
    });
    expect(events.all().map((event) => event.type)).toEqual([
      'webhook-received',
      'payment-confirmed',
    ]);
    expect(events.all()[1]?.paymentId).toBe(pending.id);
  });

  it('confirms once when the same notification is delivered again, and records the repeat', async () => {
    gateway.setOrder('ORDTST01', {
      state: 'PAID',
      method: 'pix',
      paidAt: PAID_AT,
    });

    const first = await notify();
    const second = await notify();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(database.pendingEvents()).toHaveLength(1);
    expect(events.all().map((event) => event.type)).toEqual([
      'webhook-received',
      'payment-confirmed',
      'webhook-received',
      'payment-approval-ignored',
    ]);
  });

  it('does not confirm a payment that is no longer pending', async () => {
    payments.save({ ...pending, status: 'FAILED' });
    gateway.setOrder('ORDTST01', {
      state: 'PAID',
      method: 'pix',
      paidAt: PAID_AT,
    });

    const response = await notify();

    expect(response.status).toBe(200);
    expect(payments.all()[0]?.status).toBe('FAILED');
    expect(database.pendingEvents()).toEqual([]);
    expect(events.all().at(-1)?.type).toBe('payment-approval-ignored');
  });

  it('only records a declined card, without touching the payment or publishing payment-failed', async () => {
    gateway.setOrder('ORDTST01', {
      state: 'DECLINED',
      detail: 'cc_rejected_insufficient_amount',
    });

    const response = await notify();

    expect(response.status).toBe(200);
    expect(payments.all()[0]).toEqual(pending);
    expect(database.outboxEvents()).toEqual([]);
    expect(events.all()[1]).toEqual({
      paymentId: pending.id,
      type: 'payment-declined',
      payload: { detail: 'cc_rejected_insufficient_amount' },
    });
  });

  it('records a notification about an order that is still open and changes nothing', async () => {
    const response = await notify();

    expect(response.status).toBe(200);
    expect(payments.all()[0]).toEqual(pending);
    expect(database.outboxEvents()).toEqual([]);
    expect(events.all().map((event) => event.type)).toEqual([
      'webhook-received',
    ]);
  });

  it('records a notification that matches no payment and answers 200 so the provider stops retrying', async () => {
    gateway.knowNotification(NOTIFICATION_ID, crypto.randomUUID());

    const response = await notify();

    expect(response.status).toBe(200);
    expect(events.all().map((event) => event.type)).toEqual([
      'webhook-received',
      'webhook-unmatched',
    ]);
    expect(database.outboxEvents()).toEqual([]);
  });

  it('records a notification the provider cannot relate to any order', async () => {
    const response = await notify({ id: '999' });

    expect(response.status).toBe(200);
    expect(events.all().at(-1)?.type).toBe('webhook-unmatched');
  });

  it('records a payment that never got a provider order as unmatched', async () => {
    const { providerPaymentId: _removed, ...withoutOrder } = pending;
    payments.save(withoutOrder);

    const response = await notify();

    expect(response.status).toBe(200);
    expect(events.all().at(-1)?.type).toBe('webhook-unmatched');
  });

  it('answers 502 when the provider cannot be queried, so it delivers the notification again', async () => {
    gateway.failLookups(new PaymentGatewayError('down', true, 'http_503'));

    const response = await notify();

    expect(response.status).toBe(502);
    expect(events.all().map((event) => event.type)).toEqual([
      'webhook-received',
    ]);
    expect(payments.all()[0]).toEqual(pending);
  });

  it('records a legacy notification without data.id as rejected', async () => {
    const response = await app.handle(
      new Request(
        'http://localhost/webhooks/mercadopago?topic=merchant_order&id=1',
        {
          method: 'POST',
          body: '{}',
        },
      ),
    );

    expect(response.status).toBe(401);
    expect(events.all().map((event) => event.type)).toEqual([
      'webhook-rejected',
    ]);
  });
});
