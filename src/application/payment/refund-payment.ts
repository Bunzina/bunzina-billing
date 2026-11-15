import { z } from 'zod';
import { refundPayment, type Payment } from '@/domain/payment/payment';
import type { PaymentEventLog } from '@/domain/payment/payment-event-log';
import type { PaymentGateway } from '@/domain/payment/payment-gateway';
import type { PaymentRepository } from '@/domain/payment/payment-repository';
import {
  InvalidMessageError,
  type MessageHandler,
} from '@/infrastructure/messaging/consumer';
import { refundsTotal } from '@/infrastructure/observability/metrics';

const commandSchema = z.object({
  serviceOrderId: z.uuid(),
  paymentId: z.uuid(),
  amountCents: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  reason: z.string().min(1),
  detail: z.string().optional(),
});

const paymentRefundedData = (payment: Payment) => ({
  serviceOrderId: payment.serviceOrderId,
  paymentId: payment.id,
  providerRefundId: payment.providerRefundId,
  amountCents: payment.amountCents,
  currency: payment.currency,
  refundedAt: payment.refundedAt?.toISOString(),
});

type Dependencies = {
  payments: PaymentRepository;
  events: PaymentEventLog;
  gateway: PaymentGateway;
  clock: () => Date;
};

export const createRefundHandler =
  ({ payments, events, gateway, clock }: Dependencies): MessageHandler =>
  async ({ envelope, tx, emit, afterCommit }) => {
    const parsed = commandSchema.safeParse(envelope.data);

    if (!parsed.success) {
      throw new InvalidMessageError(z.prettifyError(parsed.error));
    }

    const payment = await payments.findByIdForUpdate(tx, parsed.data.paymentId);

    if (!payment || payment.serviceOrderId !== parsed.data.serviceOrderId) {
      throw new InvalidMessageError('payment not found for the service order');
    }

    if (
      payment.amountCents !== parsed.data.amountCents ||
      payment.currency !== parsed.data.currency
    ) {
      throw new InvalidMessageError(
        'refund amount does not match the confirmed payment',
      );
    }

    if (payment.status === 'REFUNDED') {
      await emit('evt.billing.payment-refunded', paymentRefundedData(payment));
      return;
    }

    if (payment.status !== 'CONFIRMED') {
      throw new InvalidMessageError(
        `a ${payment.status} payment cannot be refunded`,
      );
    }

    if (!payment.providerPaymentId) {
      throw new InvalidMessageError('payment has no provider order to refund');
    }

    const { providerRefundId } = await gateway.refund({
      paymentId: payment.id,
      providerPaymentId: payment.providerPaymentId,
    });
    const refunded = refundPayment(payment, {
      providerRefundId,
      refundedAt: clock(),
    });

    if (!(await payments.refundIfConfirmed(tx, refunded))) {
      throw new Error('payment changed while it was being refunded');
    }

    await events.record(tx, {
      paymentId: payment.id,
      type: 'payment-refunded',
      payload: { providerRefundId, reason: parsed.data.reason },
    });
    await emit('evt.billing.payment-refunded', paymentRefundedData(refunded));

    afterCommit(async () => {
      refundsTotal.inc();
    });
  };
