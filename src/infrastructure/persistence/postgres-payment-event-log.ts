import type { PaymentEventLog } from '@/domain/payment/payment-event-log';

export const postgresPaymentEventLog: PaymentEventLog = {
  async record(tx, { paymentId, type, payload }) {
    await tx`
      INSERT INTO bunzina.payment_events (id, payment_id, event_type, payload)
      VALUES (
        ${Bun.randomUUIDv7()}, ${paymentId ?? null}, ${type},
        ${JSON.stringify(payload)}::jsonb
      )
    `;
  },
};
