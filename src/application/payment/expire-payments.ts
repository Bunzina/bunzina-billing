import { failPayment, type Payment } from '@/domain/payment/payment';
import type { PaymentEventLog } from '@/domain/payment/payment-event-log';
import type { PaymentGateway } from '@/domain/payment/payment-gateway';
import type { PaymentRepository } from '@/domain/payment/payment-repository';
import { buildEnvelope } from '@/infrastructure/messaging/envelope';
import type { MessageStore } from '@/infrastructure/messaging/message-store';
import { paymentsTotal } from '@/infrastructure/observability/metrics';
import { expireCheckout } from './expire-checkout';
import { paymentFailedData } from './payment-failed-event';

export const DEFAULT_EXPIRATION_BATCH_SIZE = 20;

type Dependencies = {
  payments: PaymentRepository;
  events: PaymentEventLog;
  gateway: PaymentGateway | undefined;
  store: MessageStore;
  clock: () => Date;
  batchSize?: number;
};

export const createExpirePayments = ({
  payments,
  events,
  gateway,
  store,
  clock,
  batchSize = DEFAULT_EXPIRATION_BATCH_SIZE,
}: Dependencies) => {
  const expireBatch = (): Promise<{ claimed: number; expired: Payment[] }> =>
    store.transact(async (tx) => {
      const due = await payments.claimExpired(tx, clock(), batchSize);
      const expired: Payment[] = [];

      for (const payment of due) {
        const failed: Payment = failPayment(payment, {
          reason: 'EXPIRED',
          detail: 'expired',
        });

        if (!(await payments.failIfPending(tx, failed))) {
          continue;
        }

        await events.record(tx, {
          paymentId: payment.id,
          type: 'payment-expired',
          payload: { expiresAt: payment.expiresAt?.toISOString() },
        });
        await store.enqueue(
          tx,
          buildEnvelope({
            eventType: 'evt.billing.payment-failed',
            correlationId: failed.serviceOrderId,
            data: paymentFailedData(failed),
          }),
        );
        expired.push(payment);
      }

      return { claimed: due.length, expired };
    });

  return async (): Promise<number> => {
    let total = 0;

    for (;;) {
      const { claimed, expired } = await expireBatch();

      paymentsTotal.inc({ status: 'FAILED' }, expired.length);
      total += expired.length;

      // After the commit, so the row locks are not held across provider calls.
      for (const payment of expired) {
        await expireCheckout(
          {
            gateway,
            record: (event) => store.transact((tx) => events.record(tx, event)),
          },
          payment,
        );
      }

      if (claimed < batchSize) {
        return total;
      }
    }
  };
};
