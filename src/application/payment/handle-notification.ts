import { confirmPayment, type Payment } from '@/domain/payment/payment';
import type { PaymentEventLog } from '@/domain/payment/payment-event-log';
import type {
  PaymentGateway,
  ProviderOrder,
} from '@/domain/payment/payment-gateway';
import type { PaymentRepository } from '@/domain/payment/payment-repository';
import { buildEnvelope } from '@/infrastructure/messaging/envelope';
import type { MessageStore } from '@/infrastructure/messaging/message-store';
import { paymentsTotal } from '@/infrastructure/observability/metrics';

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
  clock: () => Date;
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
}: Dependencies) => {
  const confirm = async (payment: Payment, order: Paid): Promise<boolean> =>
    store.transact(async (tx) => {
      const confirmed = confirmPayment(payment, order);
      const changed = await payments.confirmIfPending(tx, confirmed);
      await events.record(tx, {
        paymentId: payment.id,
        type: changed ? 'payment-confirmed' : 'payment-approval-ignored',
        payload: { providerPaymentId: payment.providerPaymentId },
      });
      if (changed) {
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

  const record = (
    type: string,
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
    if (order.state === 'PAID' && (await confirm(payment, order))) {
      paymentsTotal.inc({ status: 'CONFIRMED' });
    }

    return 'processed';
  };
};
