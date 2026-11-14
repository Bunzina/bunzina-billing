import type { Quote, QuoteStatus } from '@/domain/quote/quote';
import type { QuoteRepository } from '@/domain/quote/quote-repository';
import { db } from '@/infrastructure/configs/database';

type QuoteRow = {
  id: string;
  service_order_id: string;
  customer_id: string;
  customer_name: string;
  customer_document: string;
  customer_email: string | null;
  status: QuoteStatus;
  services_total_cents: string | number;
  auto_parts_total_cents: string | number;
  total_cents: string | number;
  currency: string;
  items: Quote['items'];
  expires_at: Date;
  created_at: Date;
  approved_at: Date | null;
  approved_by: string | null;
  rejected_at: Date | null;
  rejection_reason: 'CUSTOMER_REQUEST' | null;
  canceled_at: Date | null;
};

const toQuote = (row: QuoteRow): Quote => ({
  id: row.id,
  serviceOrderId: row.service_order_id,
  customer: {
    id: row.customer_id,
    name: row.customer_name,
    document: row.customer_document,
    email: row.customer_email ?? '',
  },
  status: row.status,
  items: row.items,
  servicesTotalCents: Number(row.services_total_cents),
  autoPartsTotalCents: Number(row.auto_parts_total_cents),
  totalCents: Number(row.total_cents),
  currency: row.currency,
  expiresAt: new Date(row.expires_at),
  createdAt: new Date(row.created_at),
  ...(row.approved_at ? { approvedAt: new Date(row.approved_at) } : {}),
  ...(row.approved_by ? { approvedBy: row.approved_by } : {}),
  ...(row.rejected_at ? { rejectedAt: new Date(row.rejected_at) } : {}),
  ...(row.rejection_reason ? { rejectionReason: row.rejection_reason } : {}),
  ...(row.canceled_at ? { canceledAt: new Date(row.canceled_at) } : {}),
});

export const postgresQuoteRepository: QuoteRepository = {
  async findById(id) {
    const [row] = await db`
      SELECT * FROM bunzina.quotes WHERE id = ${id}
    `;

    return row ? toQuote(row as QuoteRow) : null;
  },

  async findByIdForUpdate(tx, id) {
    const [row] = await tx`
      SELECT * FROM bunzina.quotes WHERE id = ${id} FOR UPDATE
    `;

    return row ? toQuote(row as QuoteRow) : null;
  },

  async findActiveByServiceOrder(tx, serviceOrderId) {
    const [row] = await tx`
      SELECT * FROM bunzina.quotes
      WHERE service_order_id = ${serviceOrderId}
        AND status IN ('ISSUED', 'APPROVED')
    `;

    return row ? toQuote(row as QuoteRow) : null;
  },

  async insert(tx, quote) {
    await tx`
      INSERT INTO bunzina.quotes (
        id, service_order_id,
        customer_id, customer_name, customer_document, customer_email,
        status, services_total_cents, auto_parts_total_cents, total_cents,
        currency, items, expires_at, created_at, updated_at
      ) VALUES (
        ${quote.id}, ${quote.serviceOrderId},
        ${quote.customer.id}, ${quote.customer.name},
        ${quote.customer.document}, ${quote.customer.email},
        ${quote.status}, ${quote.servicesTotalCents},
        ${quote.autoPartsTotalCents}, ${quote.totalCents},
        ${quote.currency}, ${JSON.stringify(quote.items)}::jsonb,
        ${quote.expiresAt}, ${quote.createdAt}, ${quote.createdAt}
      )
    `;
  },

  async update(tx, quote) {
    await tx`
      UPDATE bunzina.quotes SET
        status = ${quote.status},
        approved_at = ${quote.approvedAt ?? null},
        approved_by = ${quote.approvedBy ?? null},
        rejected_at = ${quote.rejectedAt ?? null},
        rejection_reason = ${quote.rejectionReason ?? null},
        canceled_at = ${quote.canceledAt ?? null},
        updated_at = now()
      WHERE id = ${quote.id}
    `;
  },
};
