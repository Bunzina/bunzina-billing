import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createHandleNotification } from '@/application/payment/handle-notification';
import { attachCheckout, createPendingPayment } from '@/domain/payment/payment';
import { approveQuote, issueQuote } from '@/domain/quote/quote';
import { postgresMessageStore } from '@/infrastructure/messaging/message-store';
import { createFakePaymentGateway } from '@/test/fake-payment-gateway';
import {
  applyMigrations,
  countRows,
  db,
  resetQuoteTables,
} from '@/test/integration-database';
import { postgresPaymentEventLog } from './postgres-payment-event-log';
import { postgresPaymentRepository } from './postgres-payment-repository';
import { postgresQuoteRepository } from './postgres-quote-repository';

const NOW = new Date('2026-09-17T14:03:22.115Z');
const PAID_AT = new Date('2026-09-17T14:31:08.000Z');
const NOTIFICATION = {
  authentic: true as const,
  notificationId: '46119445524',
  received: { query: { 'data.id': '46119445524' } },
};

const storePendingPayment = async () => {
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
  const payment = attachCheckout(
    createPendingPayment({
      quoteId: quote.id,
      serviceOrderId: quote.serviceOrderId,
      amountCents: quote.totalCents,
      currency: quote.currency,
      now: NOW,
    }),
    { providerPaymentId: 'ORDTST01', checkoutUrl: 'https://checkout.fake/x' },
  );
  await postgresMessageStore.transact((tx) =>
    postgresPaymentRepository.insert(tx, payment),
  );

  return payment;
};

const newInstance = (gateway: ReturnType<typeof createFakePaymentGateway>) =>
  createHandleNotification({
    payments: postgresPaymentRepository,
    events: postgresPaymentEventLog,
    gateway,
    store: postgresMessageStore,
  });

const eventTypes = async () =>
  (
    await db`SELECT event_type FROM bunzina.payment_events ORDER BY event_type`
  ).map((row: { event_type: string }) => row.event_type);

describe('payment webhook against Postgres', () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await resetQuoteTables();
    await db`TRUNCATE bunzina.payment_events`;
  });

  it('confirms once when two replicas handle the same approved notification at the same time', async () => {
    const payment = await storePendingPayment();
    const gateways = [createFakePaymentGateway(), createFakePaymentGateway()];
    let arrived = 0;
    let release: () => void = () => {};
    const bothQueried = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const gateway of gateways) {
      gateway.knowNotification(NOTIFICATION.notificationId, payment.id);
      gateway.setOrder('ORDTST01', {
        state: 'PAID',
        method: 'pix',
        paidAt: PAID_AT,
      });
      const getOrder = gateway.getOrder.bind(gateway);
      gateway.getOrder = async (id) => {
        const order = await getOrder(id);
        arrived += 1;
        if (arrived === 2) {
          release();
        }
        await bothQueried;
        return order;
      };
    }

    await Promise.all(
      gateways.map((gateway) => newInstance(gateway)(NOTIFICATION)),
    );

    const [stored] = await db`
      SELECT status, method, paid_at FROM bunzina.payments WHERE id = ${payment.id}
    `;
    const outbox = await db`SELECT payload FROM bunzina.outbox_messages`;
    expect(stored).toMatchObject({ status: 'CONFIRMED', method: 'pix' });
    expect(new Date(stored?.paid_at)).toEqual(PAID_AT);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.payload).toMatchObject({
      eventType: 'evt.billing.payment-confirmed',
      data: { paymentId: payment.id, providerPaymentId: 'ORDTST01' },
    });
    expect(await eventTypes()).toEqual([
      'payment-approval-ignored',
      'payment-confirmed',
      'webhook-received',
      'webhook-received',
    ]);
  });

  it('keeps a declined card and a rejected attempt in payment_events and nothing else', async () => {
    const payment = await storePendingPayment();
    const gateway = createFakePaymentGateway();
    gateway.knowNotification(NOTIFICATION.notificationId, payment.id);
    gateway.setOrder('ORDTST01', {
      state: 'DECLINED',
      detail: 'rejected_high_risk',
    });
    const handle = newInstance(gateway);

    await handle(NOTIFICATION);
    await handle({ authentic: false, received: { query: {} } });

    const [stored] =
      await db`SELECT status FROM bunzina.payments WHERE id = ${payment.id}`;
    expect(stored?.status).toBe('PENDING');
    expect(await countRows('bunzina.outbox_messages')).toBe(0);
    expect(await eventTypes()).toEqual([
      'payment-declined',
      'webhook-received',
      'webhook-rejected',
    ]);
    const [declined] = await db`
      SELECT payment_id, payload FROM bunzina.payment_events WHERE event_type = 'payment-declined'
    `;
    expect(declined).toMatchObject({
      payment_id: payment.id,
      payload: { detail: 'rejected_high_risk' },
    });
  });
});
