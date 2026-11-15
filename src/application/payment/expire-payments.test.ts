import { beforeEach, describe, expect, it } from 'bun:test';
import {
  attachCheckout,
  createPendingPayment,
  type Payment,
} from '@/domain/payment/payment';
import { PaymentGatewayError } from '@/domain/payment/payment-gateway';
import { paymentsTotal } from '@/infrastructure/observability/metrics';
import { createFakePaymentGateway } from '@/test/fake-payment-gateway';
import { createInMemoryMessageStore } from '@/test/in-memory-message-store';
import { createInMemoryPaymentEventLog } from '@/test/in-memory-payment-event-log';
import { createInMemoryPaymentRepository } from '@/test/in-memory-payment-repository';
import { createExpirePayments } from './expire-payments';

const CREATED_AT = new Date('2026-09-17T14:00:00.000Z');
const VALIDITY_MINUTES = 30;
const minutesAfterCreation = (minutes: number) =>
  new Date(CREATED_AT.getTime() + minutes * 60 * 1000);

let now: Date;
let payments: ReturnType<typeof createInMemoryPaymentRepository>;
let events: ReturnType<typeof createInMemoryPaymentEventLog>;
let gateway: ReturnType<typeof createFakePaymentGateway>;
let database: ReturnType<typeof createInMemoryMessageStore>;

const counterValue = async (status: string) => {
  const { values } = await paymentsTotal.get();

  return values.find((entry) => entry.labels.status === status)?.value ?? 0;
};

const storePending = (suffix: number): Payment => {
  const payment = attachCheckout(
    createPendingPayment({
      quoteId: `0193f2a1-4c7e-7000-8000-00000000010${suffix}`,
      serviceOrderId: `0193f2a1-4c7e-7000-8000-00000000020${suffix}`,
      amountCents: 21000,
      currency: 'BRL',
      now: CREATED_AT,
      validityMinutes: VALIDITY_MINUTES,
    }),
    {
      providerPaymentId: `ORDTST0${suffix}`,
      checkoutUrl: `https://checkout.fake/${suffix}`,
    },
  );

  payments.save(payment);

  return payment;
};

const newInstance = (batchSize = 50) =>
  createExpirePayments({
    payments,
    events,
    gateway,
    store: database.store,
    clock: () => now,
    batchSize,
  });

beforeEach(() => {
  now = minutesAfterCreation(VALIDITY_MINUTES + 1);
  payments = createInMemoryPaymentRepository();
  events = createInMemoryPaymentEventLog();
  gateway = createFakePaymentGateway();
  database = createInMemoryMessageStore();
});

describe('expiring pending payments', () => {
  it('fails an unpaid payment past its validity with EXPIRED and publishes payment-failed', async () => {
    const payment = storePending(1);

    expect(await newInstance()()).toBe(1);

    expect(await payments.findById(payment.id)).toMatchObject({
      status: 'FAILED',
      failureReason: 'EXPIRED',
    });
    expect(database.pendingEvents()).toMatchObject([
      {
        eventType: 'evt.billing.payment-failed',
        correlationId: payment.serviceOrderId,
        data: {
          serviceOrderId: payment.serviceOrderId,
          paymentId: payment.id,
          quoteId: payment.quoteId,
          reason: 'EXPIRED',
        },
      },
    ]);
    expect(events.all()).toMatchObject([
      { paymentId: payment.id, type: 'payment-expired' },
    ]);
  });

  it('leaves alone a payment that is still within its validity', async () => {
    const payment = storePending(1);
    now = minutesAfterCreation(VALIDITY_MINUTES - 1);

    expect(await newInstance()()).toBe(0);

    expect((await payments.findById(payment.id))?.status).toBe('PENDING');
    expect(database.outboxEvents()).toHaveLength(0);
    expect(gateway.expired).toHaveLength(0);
  });

  it.each(['CONFIRMED', 'FAILED', 'REFUNDED'] as const)(
    'leaves a %s payment alone',
    async (status) => {
      const payment = storePending(1);
      payments.save({ ...payment, status });

      expect(await newInstance()()).toBe(0);

      expect((await payments.findById(payment.id))?.status).toBe(status);
      expect(database.outboxEvents()).toHaveLength(0);
    },
  );

  it('does nothing the second time it runs', async () => {
    storePending(1);
    const expire = newInstance();

    await expire();
    await expire();

    expect(database.outboxEvents()).toHaveLength(1);
    expect(gateway.expired).toHaveLength(1);
  });

  it('works through every due payment, one batch at a time', async () => {
    [1, 2, 3, 4, 5].forEach(storePending);

    expect(await newInstance(2)()).toBe(5);

    expect(payments.all().map((payment) => payment.status)).toEqual(
      Array(5).fill('FAILED'),
    );
    expect(database.outboxEvents()).toHaveLength(5);
  });

  it('neither fails a payment nor publishes its event twice when two instances run together', async () => {
    [1, 2, 3].forEach(storePending);

    const counts = await Promise.all([newInstance()(), newInstance()()]);

    expect(counts.reduce((total, count) => total + count, 0)).toBe(3);
    expect(database.outboxEvents()).toHaveLength(3);
    expect(
      events.all().filter((e) => e.type === 'payment-expired'),
    ).toHaveLength(3);
    expect(gateway.expired).toHaveLength(3);
  });

  it('counts each expired payment as FAILED', async () => {
    storePending(1);
    const before = await counterValue('FAILED');

    await newInstance()();

    expect(await counterValue('FAILED')).toBe(before + 1);
  });

  describe('the checkout at Mercado Pago', () => {
    it('is expired too, by the id of its order', async () => {
      storePending(1);

      await newInstance()();

      expect(gateway.expired).toEqual(['ORDTST01']);
    });

    it('does not keep the payment from failing when it cannot be expired, and the failure is recorded', async () => {
      const payment = storePending(1);
      gateway.failExpirations(
        new PaymentGatewayError('mercadopago cancel failed', true, 'http_503'),
      );

      await newInstance()();

      expect((await payments.findById(payment.id))?.status).toBe('FAILED');
      expect(database.pendingEvents()).toHaveLength(1);
      expect(events.all()).toMatchObject([
        { paymentId: payment.id, type: 'payment-expired' },
        {
          paymentId: payment.id,
          type: 'checkout-expiry-failed',
          payload: { providerPaymentId: 'ORDTST01' },
        },
      ]);
    });
  });
});
