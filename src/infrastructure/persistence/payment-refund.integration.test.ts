import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createHandleNotification } from '@/application/payment/handle-notification';
import {
  attachCheckout,
  confirmPayment,
  createPendingPayment,
  failPayment,
  refundLatePayment,
  refundPayment,
} from '@/domain/payment/payment';
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
const REFUNDED_AT = new Date('2026-09-17T17:00:00.000Z');
const NOTIFICATION = {
  authentic: true as const,
  notificationId: '46119445524',
  received: { query: { 'data.id': '46119445524' } },
};

const storePayment = async () => {
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
      validityMinutes: 30,
    }),
    { providerPaymentId: 'ORDTST01', checkoutUrl: 'https://checkout.fake/x' },
  );
  await postgresMessageStore.transact((tx) =>
    postgresPaymentRepository.insert(tx, payment),
  );

  return payment;
};

describe('payment refunds against Postgres', () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await resetQuoteTables();
    await db`TRUNCATE bunzina.payment_events`;
  });

  it('stores a refund once and keeps the first refund id', async () => {
    const payment = await storePayment();
    const refunded = refundPayment(payment, {
      providerRefundId: 'REF01',
      refundedAt: REFUNDED_AT,
    });

    await postgresMessageStore.transact((tx) =>
      postgresPaymentRepository.confirmIfPending(
        tx,
        confirmPayment(payment, { method: 'pix', paidAt: NOW }),
      ),
    );

    const results = await postgresMessageStore.transact(async (tx) => [
      await postgresPaymentRepository.refundIfConfirmed(tx, refunded),
      await postgresPaymentRepository.refundIfConfirmed(tx, {
        ...refunded,
        providerRefundId: 'REF02',
      }),
    ]);

    const stored = await postgresPaymentRepository.findById(payment.id);
    expect(results).toEqual([true, false]);
    expect(stored).toMatchObject({
      status: 'REFUNDED',
      providerRefundId: 'REF01',
      refundedAt: REFUNDED_AT,
    });
  });

  it('only refunds a confirmed payment, and only marks a late refund on a failed one', async () => {
    const payment = await storePayment();
    const refund = { providerRefundId: 'REF01', refundedAt: REFUNDED_AT };

    const pendingResults = await postgresMessageStore.transact(async (tx) => [
      await postgresPaymentRepository.refundIfConfirmed(
        tx,
        refundPayment(payment, refund),
      ),
      await postgresPaymentRepository.markLateRefunded(
        tx,
        refundLatePayment(payment, refund),
      ),
    ]);

    expect(pendingResults).toEqual([false, false]);
    expect(
      (await postgresPaymentRepository.findById(payment.id))?.refundedAt,
    ).toBeUndefined();
  });

  it('locks the payment row for the transaction that reads it for update', async () => {
    const payment = await storePayment();

    const found = await postgresMessageStore.transact((tx) =>
      postgresPaymentRepository.findByIdForUpdate(tx, payment.id),
    );
    const missing = await postgresMessageStore.transact((tx) =>
      postgresPaymentRepository.findByIdForUpdate(tx, crypto.randomUUID()),
    );

    expect(found?.id).toBe(payment.id);
    expect(missing).toBeNull();
  });

  it('refunds a late approval once when two replicas handle the notification at the same time', async () => {
    const payment = await storePayment();
    await postgresMessageStore.transact((tx) =>
      postgresPaymentRepository.failIfPending(
        tx,
        failPayment(payment, { reason: 'EXPIRED', detail: 'expired' }),
      ),
    );
    const gateways = [createFakePaymentGateway(), createFakePaymentGateway()];
    for (const gateway of gateways) {
      gateway.knowNotification(NOTIFICATION.notificationId, payment.id);
      gateway.setOrder('ORDTST01', {
        state: 'PAID',
        method: 'pix',
        paidAt: REFUNDED_AT,
      });
    }

    await Promise.all(
      gateways.map((gateway) =>
        createHandleNotification({
          payments: postgresPaymentRepository,
          events: postgresPaymentEventLog,
          gateway,
          store: postgresMessageStore,
          clock: () => REFUNDED_AT,
        })(NOTIFICATION),
      ),
    );

    const stored = await postgresPaymentRepository.findById(payment.id);
    const recorded = await db`
      SELECT payload FROM bunzina.payment_events WHERE event_type = 'late-payment-refunded'
    `;
    expect(stored).toMatchObject({
      status: 'FAILED',
      providerRefundId: 'REFFAKE1',
      refundedAt: REFUNDED_AT,
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.payload).toEqual({
      providerRefundId: 'REFFAKE1',
      failureReason: 'EXPIRED',
    });
    expect(await countRows('bunzina.outbox_messages')).toBe(0);
  });
});
