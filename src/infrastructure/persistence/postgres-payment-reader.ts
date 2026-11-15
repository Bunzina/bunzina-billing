import type { PaymentReader } from '@/domain/payment/payment-reader';

export const postgresPaymentReader: PaymentReader = {
  async hasConfirmedPayment(tx, quoteId) {
    const rows = await tx`
      SELECT 1 FROM bunzina.payments
      WHERE quote_id = ${quoteId} AND status = 'CONFIRMED'
      LIMIT 1
    `;

    return rows.length > 0;
  },
};
