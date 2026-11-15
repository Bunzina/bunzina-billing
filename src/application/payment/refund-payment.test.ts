import { beforeEach, describe, expect, it } from 'bun:test';
import {
  attachCheckout,
  confirmPayment,
  createPendingPayment,
  type Payment,
} from '@/domain/payment/payment';
import { PaymentGatewayError } from '@/domain/payment/payment-gateway';
import { refundsTotal } from '@/infrastructure/observability/metrics';
import { buildCommand, createConsumerHarness } from '@/test/consumer-harness';
import { createFakePaymentGateway } from '@/test/fake-payment-gateway';
import { createInMemoryMessageStore } from '@/test/in-memory-message-store';
import { createInMemoryPaymentEventLog } from '@/test/in-memory-payment-event-log';
import { createInMemoryPaymentRepository } from '@/test/in-memory-payment-repository';
import { createRefundHandler } from './refund-payment';

const NOW = new Date('2026-09-17T17:00:00.000Z');

let payments: ReturnType<typeof createInMemoryPaymentRepository>;
let events: ReturnType<typeof createInMemoryPaymentEventLog>;
let gateway: ReturnType<typeof createFakePaymentGateway>;
let database: ReturnType<typeof createInMemoryMessageStore>;
let harness: Awaited<ReturnType<typeof createConsumerHarness>>;

const refundsCounter = async () => {
  const { values } = await refundsTotal.get();

  return values.reduce((sum, entry) => sum + entry.value, 0);
};

const storeConfirmed = (): Payment => {
  const payment = confirmPayment(
    attachCheckout(
      createPendingPayment({
        quoteId: crypto.randomUUID(),
        serviceOrderId: crypto.randomUUID(),
        amountCents: 54500,
        currency: 'BRL',
        now: new Date('2026-09-17T14:03:22.115Z'),
        validityMinutes: 30,
      }),
      { providerPaymentId: 'ORDTST01', checkoutUrl: 'https://checkout.fake/1' },
    ),
    { method: 'pix', paidAt: new Date('2026-09-17T14:31:08.000Z') },
  );

  payments.save(payment);

  return payment;
};

const refundCommand = (payment: Payment, overrides = {}) =>
  buildCommand({
    eventType: 'cmd.billing.refund',
    correlationId: payment.serviceOrderId,
    data: {
      serviceOrderId: payment.serviceOrderId,
      paymentId: payment.id,
      amountCents: payment.amountCents,
      currency: payment.currency,
      reason: 'PART_UNAVAILABLE',
      detail: 'part is out of stock',
      ...overrides,
    },
  });

beforeEach(async () => {
  payments = createInMemoryPaymentRepository();
  events = createInMemoryPaymentEventLog();
  gateway = createFakePaymentGateway();
  database = createInMemoryMessageStore();
  harness = await createConsumerHarness(
    {
      'cmd.billing.refund': createRefundHandler({
        payments,
        events,
        gateway,
        clock: () => NOW,
      }),
    },
    database.store,
  );
});

describe('cmd.billing.refund', () => {
  it('refunds a confirmed payment in full at the provider and publishes payment-refunded with the refund id', async () => {
    const payment = storeConfirmed();
    const command = refundCommand(payment);
    const before = await refundsCounter();

    await harness.deliver(command);

    expect(harness.ack).toHaveBeenCalledTimes(1);
    expect(gateway.refunds).toEqual([
      { paymentId: payment.id, providerPaymentId: 'ORDTST01' },
    ]);
    expect(await payments.findById(payment.id)).toMatchObject({
      status: 'REFUNDED',
      providerRefundId: 'REFFAKE1',
      refundedAt: NOW,
    });
    expect(database.pendingEvents()).toMatchObject([
      {
        eventType: 'evt.billing.payment-refunded',
        correlationId: payment.serviceOrderId,
        causationId: command.eventId,
        data: {
          serviceOrderId: payment.serviceOrderId,
          paymentId: payment.id,
          providerRefundId: 'REFFAKE1',
          amountCents: 54500,
          currency: 'BRL',
          refundedAt: '2026-09-17T17:00:00.000Z',
        },
      },
    ]);
    expect(events.all()).toMatchObject([
      { paymentId: payment.id, type: 'payment-refunded' },
    ]);
    expect(await refundsCounter()).toBe(before + 1);
  });

  it('does not call the provider again for an already refunded payment, and re-emits payment-refunded with the original refund', async () => {
    const payment = storeConfirmed();
    const before = await refundsCounter();

    await harness.deliver(refundCommand(payment));
    await harness.deliver(refundCommand(payment));

    expect(harness.ack).toHaveBeenCalledTimes(2);
    expect(gateway.refunds).toHaveLength(1);
    expect(database.pendingEvents()).toHaveLength(2);
    expect(database.pendingEvents()[1]).toMatchObject({
      eventType: 'evt.billing.payment-refunded',
      data: {
        paymentId: payment.id,
        providerRefundId: 'REFFAKE1',
        refundedAt: '2026-09-17T17:00:00.000Z',
      },
    });
    expect(await refundsCounter()).toBe(before + 1);
  });

  it.each(['PENDING', 'FAILED'] as const)(
    'dead-letters a refund for a %s payment without calling the provider',
    async (status) => {
      const payment = { ...storeConfirmed(), status };
      payments.save(payment);

      await harness.deliver(refundCommand(payment));

      expect(harness.nack).toHaveBeenCalledTimes(1);
      expect(harness.ack).not.toHaveBeenCalled();
      expect(gateway.refunds).toEqual([]);
      expect(database.outboxEvents()).toEqual([]);
      expect((await payments.findById(payment.id))?.status).toBe(status);
    },
  );

  it.each([
    ['a malformed command', { paymentId: 'nope' }],
    ['another service order', { serviceOrderId: crypto.randomUUID() }],
    ['an amount that differs from the payment', { amountCents: 100 }],
    ['a currency that differs from the payment', { currency: 'USD' }],
  ])('dead-letters a refund with %s', async (_label, overrides) => {
    const payment = storeConfirmed();

    await harness.deliver(refundCommand(payment, overrides));

    expect(harness.nack).toHaveBeenCalledTimes(1);
    expect(gateway.refunds).toEqual([]);
    expect((await payments.findById(payment.id))?.status).toBe('CONFIRMED');
  });

  it('dead-letters a refund for a payment that does not exist', async () => {
    const payment = storeConfirmed();

    await harness.deliver(
      refundCommand(payment, { paymentId: crypto.randomUUID() }),
    );

    expect(harness.nack).toHaveBeenCalledTimes(1);
    expect(gateway.refunds).toEqual([]);
  });

  it('dead-letters a refund for a payment that has no provider order', async () => {
    const { providerPaymentId: _removed, ...withoutOrder } = storeConfirmed();
    payments.save(withoutOrder);

    await harness.deliver(refundCommand(withoutOrder));

    expect(harness.nack).toHaveBeenCalledTimes(1);
    expect(gateway.refunds).toEqual([]);
  });

  it('retries a provider failure and refunds once the provider answers', async () => {
    const payment = storeConfirmed();
    gateway.failRefunds(new PaymentGatewayError('down', true, 'http_503'));

    await harness.deliver(refundCommand(payment));

    expect(harness.sleep).toHaveBeenCalledTimes(1);
    expect(harness.ack).toHaveBeenCalledTimes(1);
    expect((await payments.findById(payment.id))?.status).toBe('REFUNDED');
  });

  it('dead-letters when the provider keeps failing, leaving the payment confirmed', async () => {
    const payment = storeConfirmed();
    gateway.failRefunds(
      ...Array.from(
        { length: 3 },
        () => new PaymentGatewayError('down', true, 'http_503'),
      ),
    );

    await harness.deliver(refundCommand(payment));

    expect(harness.nack).toHaveBeenCalledTimes(1);
    expect((await payments.findById(payment.id))?.status).toBe('CONFIRMED');
    expect(database.outboxEvents()).toEqual([]);
  });
});
