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
  method: string | null;
  paid_at: Date | null;
  expires_at: Date | null;
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
  ...(row.method ? { method: row.method } : {}),
  ...(row.paid_at ? { paidAt: new Date(row.paid_at) } : {}),
  ...(row.expires_at ? { expiresAt: new Date(row.expires_at) } : {}),
  ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
  ...(row.failure_detail ? { failureDetail: row.failure_detail } : {}),
});

export const postgresPaymentRepository: PaymentRepository = {
  async findById(id) {
    const [row] = await db`
      SELECT * FROM bunzina.payments WHERE id = ${id}
    `;
    return row ? toPayment(row as PaymentRow) : null;
  },
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
        failure_reason, failure_detail, expires_at, created_at, updated_at
      ) VALUES (
        ${payment.id}, ${payment.quoteId}, ${payment.serviceOrderId},
        ${payment.status}, ${payment.amountCents}, ${payment.currency},
        ${payment.provider}, ${payment.providerPaymentId ?? null},
        ${payment.checkoutUrl ?? null},
        ${payment.failureReason ?? null}, ${payment.failureDetail ?? null},
        ${payment.expiresAt ?? null},
        ${payment.createdAt}, ${payment.createdAt}
      )
    `;
  },
  async confirmIfPending(tx, confirmed) {
    const rows = await tx`
      UPDATE bunzina.payments
      SET status = 'CONFIRMED', method = ${confirmed.method ?? null},
          paid_at = ${confirmed.paidAt ?? null}, updated_at = now()
      WHERE id = ${confirmed.id} AND status = 'PENDING'
      RETURNING id
    `;
    return rows.length > 0;
  },

  async failIfPending(tx, failed) {
    const rows = await tx`
      UPDATE bunzina.payments
      SET status = 'FAILED', failure_reason = ${failed.failureReason ?? null},
          failure_detail = ${failed.failureDetail ?? null}, updated_at = now()
      WHERE id = ${failed.id} AND status = 'PENDING'
      RETURNING id
    `;
    return rows.length > 0;
  },

  async claimExpired(tx, now, limit) {
    const rows = await tx`
      SELECT * FROM bunzina.payments
      WHERE status = 'PENDING' AND expires_at <= ${now}
      ORDER BY expires_at, id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;
    return rows.map((row: unknown) => toPayment(row as PaymentRow));
  },
};
