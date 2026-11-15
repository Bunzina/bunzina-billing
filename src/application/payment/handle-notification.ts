import {
  confirmPayment,
  refundLatePayment,
  type Payment,
} from '@/domain/payment/payment';
import type {
  PaymentEventLog,
  PaymentEventType,
} from '@/domain/payment/payment-event-log';
import type {
  PaymentGateway,
  ProviderOrder,
} from '@/domain/payment/payment-gateway';
import type { PaymentRepository } from '@/domain/payment/payment-repository';
import { buildEnvelope } from '@/infrastructure/messaging/envelope';
import type { MessageStore } from '@/infrastructure/messaging/message-store';
import {
  lateRefundsTotal,
  paymentsTotal,
} from '@/infrastructure/observability/metrics';

export type Notification =
  | { authentic: false; received: Record<string, unknown> }
  | {
      authentic: true;
      notificationId: string;
      received: Record<string, unknown>;
    };

export type NotificationOutcome = 'rejected' | 'processed';

type Dependencies = {
  payments: PaymentRepository;
  events: PaymentEventLog;
  gateway: PaymentGateway;
  store: MessageStore;
  clock?: () => Date;
};

type Paid = Extract<ProviderOrder, { state: 'PAID' }>;

const paymentConfirmedData = (payment: Payment) => ({
  serviceOrderId: payment.serviceOrderId,
  paymentId: payment.id,
  quoteId: payment.quoteId,
  provider: payment.provider,
  providerPaymentId: payment.providerPaymentId,
  amountCents: payment.amountCents,
  currency: payment.currency,
  method: payment.method,
  paidAt: payment.paidAt?.toISOString(),
});

export const createHandleNotification = ({
  payments,
  events,
  gateway,
  store,
  clock = () => new Date(),
}: Dependencies) => {
  const confirm = async (payment: Payment, order: Paid): Promise<boolean> =>
    store.transact(async (tx) => {
      const confirmed = confirmPayment(payment, order);
      const changed = await payments.confirmIfPending(tx, confirmed);
      if (changed) {
        await events.record(tx, {
          paymentId: payment.id,
          type: 'payment-confirmed',
          payload: { providerPaymentId: payment.providerPaymentId },
        });
        await store.enqueue(
          tx,
          buildEnvelope({
            eventType: 'evt.billing.payment-confirmed',
            correlationId: confirmed.serviceOrderId,
            data: paymentConfirmedData(confirmed),
          }),
        );
      }
      return changed;
    });

  const refundLate = async (
    payment: Payment,
    providerPaymentId: string,
  ): Promise<boolean> => {
    const { providerRefundId } = await gateway.refund({
      paymentId: payment.id,
      providerPaymentId,
    });
    const refunded = refundLatePayment(payment, {
      providerRefundId,
      refundedAt: clock(),
    });

    return store.transact(async (tx) => {
      if (!(await payments.markLateRefunded(tx, refunded))) {
        return false;
      }
      await events.record(tx, {
        paymentId: payment.id,
        type: 'late-payment-refunded',
        payload: { providerRefundId, failureReason: payment.failureReason },
      });
      return true;
    });
  };

  const settleApproval = async (
    payment: Payment,
    providerPaymentId: string,
    order: Paid,
  ): Promise<void> => {
    if (await confirm(payment, order)) {
      paymentsTotal.inc({ status: 'CONFIRMED' });
      return;
    }

    const current = await payments.findById(payment.id);
    if (!current || current.status !== 'FAILED' || current.refundedAt) {
      await record(
        'payment-approval-ignored',
        { providerPaymentId },
        payment.id,
      );
      return;
    }

    if (await refundLate(current, providerPaymentId)) {
      lateRefundsTotal.inc();
    }
  };

  const record = (
    type: PaymentEventType,
    payload: Record<string, unknown>,
    paymentId?: string,
  ) =>
    store.transact((tx) =>
      events.record(tx, { type, payload, ...(paymentId ? { paymentId } : {}) }),
    );

  return async (notification: Notification): Promise<NotificationOutcome> => {
    if (!notification.authentic) {
      await record('webhook-rejected', notification.received);
      return 'rejected';
    }
    await record('webhook-received', notification.received);

    const reference = await gateway.findPaymentReference(
      notification.notificationId,
    );
    const payment = reference ? await payments.findById(reference) : null;
    if (!payment?.providerPaymentId) {
      await record('webhook-unmatched', {
        notificationId: notification.notificationId,
        reference,
      });
      return 'processed';
    }

    const order = await gateway.getOrder(payment.providerPaymentId);
    if (order.state === 'DECLINED') {
      await record('payment-declined', { detail: order.detail }, payment.id);
    }
    if (order.state === 'PAID') {
      await settleApproval(payment, payment.providerPaymentId, order);
    }

    return 'processed';
  };
};
