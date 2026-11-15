import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createExpirePayments } from '@/application/payment/expire-payments';
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

const CREATED_AT = new Date('2026-09-17T14:00:00.000Z');
const AFTER_VALIDITY = new Date('2026-09-17T14:31:00.000Z');

const storePendingPayment = async (suffix: number) => {
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
      now: CREATED_AT,
      validityHours: 72,
    }),
    { approvedBy: '12345678901', now: CREATED_AT },
  );
  await postgresMessageStore.transact(async (tx) => {
    await postgresQuoteRepository.insert(tx, quote);
    await postgresPaymentRepository.insert(
      tx,
      attachCheckout(
        createPendingPayment({
          quoteId: quote.id,
          serviceOrderId: quote.serviceOrderId,
          amountCents: quote.totalCents,
          currency: quote.currency,
          now: CREATED_AT,
          validityMinutes: 30,
        }),
        {
          providerPaymentId: `ORDTST0${suffix}`,
          checkoutUrl: `https://checkout.fake/${suffix}`,
        },
      ),
    );
  });
};

const instance = (
  gateway: ReturnType<typeof createFakePaymentGateway>,
  batchSize: number,
) =>
  createExpirePayments({
    payments: postgresPaymentRepository,
    events: postgresPaymentEventLog,
    gateway,
    store: postgresMessageStore,
    clock: () => AFTER_VALIDITY,
    batchSize,
  });

describe('payment expiration against Postgres', () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await resetQuoteTables();
    await db`TRUNCATE bunzina.payment_events`;
  });

  it('fails each overdue payment once and publishes one payment-failed, within the validity or not', async () => {
    await storePendingPayment(1);
    await db`UPDATE bunzina.payments SET expires_at = ${new Date('2026-09-17T15:00:00.000Z')}`;
    await storePendingPayment(2);

    expect(await instance(createFakePaymentGateway(), 10)()).toBe(1);

    const rows = await db`
      SELECT status, failure_reason FROM bunzina.payments ORDER BY created_at, id
    `;
    expect(rows.map((row: { status: string }) => row.status).sort()).toEqual([
      'FAILED',
      'PENDING',
    ]);
    expect(await countRows('bunzina.outbox_messages')).toBe(1);
  });

  it('shares the work between two replicas without failing or publishing anything twice', async () => {
    for (const suffix of [1, 2, 3]) {
      await storePendingPayment(suffix);
    }
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstHasItsBatch: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      firstHasItsBatch = resolve;
    });
    const slow = createFakePaymentGateway();
    const expire = slow.expireCheckout.bind(slow);
    slow.expireCheckout = async (id) => {
      firstHasItsBatch();
      await held;
      await expire(id);
    };

    const first = instance(slow, 2)();
    await ready;
    const second = await instance(createFakePaymentGateway(), 2)();
    release();
    const counts = [await first, second];

    expect(counts[0]! + counts[1]!).toBe(3);
    expect(second).toBe(1);
    expect(await countRows('bunzina.outbox_messages')).toBe(3);
    const events = await db`
      SELECT payment_id FROM bunzina.payment_events WHERE event_type = 'payment-expired'
    `;
    expect(
      new Set(events.map((e: { payment_id: string }) => e.payment_id)).size,
    ).toBe(3);
    expect(events).toHaveLength(3);
  });
});
