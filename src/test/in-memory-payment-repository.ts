import type { Payment } from '@/domain/payment/payment';
import type { PaymentRepository } from '@/domain/payment/payment-repository';

export const createInMemoryPaymentRepository = () => {
  const payments = new Map<string, Payment>();

  const byQuote = (quoteId: string) =>
    [...payments.values()].find((payment) => payment.quoteId === quoteId) ??
    null;

  const replaceIfPending = (next: Payment): boolean => {
    if (payments.get(next.id)?.status !== 'PENDING') {
      return false;
    }
    payments.set(next.id, next);
    return true;
  };

  const repository: PaymentRepository & {
    all: () => Payment[];
    save: (payment: Payment) => void;
  } = {
    async findById(id) {
      return payments.get(id) ?? null;
    },
    async findByIdForUpdate(_tx, id) {
      return payments.get(id) ?? null;
    },
    async findByQuoteId(quoteId) {
      return byQuote(quoteId);
    },

    async findByQuoteIdForUpdate(_tx, quoteId) {
      return byQuote(quoteId);
    },

    async insert(_tx, payment) {
      if (byQuote(payment.quoteId)) {
        throw new Error('duplicate payment for quote');
      }

      payments.set(payment.id, payment);
    },

    async confirmIfPending(_tx, confirmed) {
      return replaceIfPending(confirmed);
    },

    async failIfPending(_tx, failed) {
      return replaceIfPending(failed);
    },

    async refundIfConfirmed(_tx, refunded) {
      if (payments.get(refunded.id)?.status !== 'CONFIRMED') {
        return false;
      }
      payments.set(refunded.id, refunded);
      return true;
    },

    async markLateRefunded(_tx, refunded) {
      const current = payments.get(refunded.id);
      if (current?.status !== 'FAILED' || current.refundedAt) {
        return false;
      }
      payments.set(refunded.id, refunded);
      return true;
    },

    async claimExpired(_tx, now, limit) {
      return [...payments.values()]
        .filter(
          (payment) =>
            payment.status === 'PENDING' &&
            payment.expiresAt !== undefined &&
            payment.expiresAt <= now,
        )
        .slice(0, limit);
    },

    all: () => [...payments.values()],
    save: (payment) => {
      payments.set(payment.id, payment);
    },
  };

  return repository;
};
