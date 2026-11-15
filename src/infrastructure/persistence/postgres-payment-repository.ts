import type {
  Payment,
  PaymentFailureReason,
  PaymentStatus,
} from '@/domain/payment/payment';
import type { PaymentRepository } from '@/domain/payment/payment-repository';
import { db } from '@/infrastructure/configs/database';

type PaymentRow = {
  id: string;
  quote_id: string;
  service_order_id: string;
  status: PaymentStatus;
  amount_cents: string | number;
  currency: string;
  provider: string;
  provider_payment_id: string | null;
  checkout_url: string | null;
  failure_reason: PaymentFailureReason | null;
  failure_detail: string | null;
  created_at: Date;
};

const toPayment = (row: PaymentRow): Payment => ({
  id: row.id,
  quoteId: row.quote_id,
  serviceOrderId: row.service_order_id,
  status: row.status,
  amountCents: Number(row.amount_cents),
  currency: row.currency,
  provider: row.provider,
  createdAt: new Date(row.created_at),
  ...(row.provider_payment_id
    ? { providerPaymentId: row.provider_payment_id }
    : {}),
  ...(row.checkout_url ? { checkoutUrl: row.checkout_url } : {}),
  ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
  ...(row.failure_detail ? { failureDetail: row.failure_detail } : {}),
});

export const postgresPaymentRepository: PaymentRepository = {
  async findByQuoteId(quoteId) {
    const [row] = await db`
      SELECT * FROM bunzina.payments WHERE quote_id = ${quoteId}
    `;

    return row ? toPayment(row as PaymentRow) : null;
  },

  async findByQuoteIdForUpdate(tx, quoteId) {
    const [row] = await tx`
      SELECT * FROM bunzina.payments WHERE quote_id = ${quoteId} FOR UPDATE
    `;

    return row ? toPayment(row as PaymentRow) : null;
  },

  async insert(tx, payment) {
    await tx`
      INSERT INTO bunzina.payments (
        id, quote_id, service_order_id, status, amount_cents, currency,
        provider, provider_payment_id, checkout_url,
        failure_reason, failure_detail, created_at, updated_at
      ) VALUES (
        ${payment.id}, ${payment.quoteId}, ${payment.serviceOrderId},
        ${payment.status}, ${payment.amountCents}, ${payment.currency},
        ${payment.provider}, ${payment.providerPaymentId ?? null},
        ${payment.checkoutUrl ?? null},
        ${payment.failureReason ?? null}, ${payment.failureDetail ?? null},
        ${payment.createdAt}, ${payment.createdAt}
      )
    `;
  },
};
