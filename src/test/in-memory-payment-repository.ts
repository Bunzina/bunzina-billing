import type { Payment } from '@/domain/payment/payment';
import type { PaymentRepository } from '@/domain/payment/payment-repository';

export const createInMemoryPaymentRepository = () => {
  const payments = new Map<string, Payment>();

  const byQuote = (quoteId: string) =>
    [...payments.values()].find((payment) => payment.quoteId === quoteId) ??
    null;

  const repository: PaymentRepository & {
    all: () => Payment[];
    save: (payment: Payment) => void;
  } = {
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

    all: () => [...payments.values()],
    save: (payment) => {
      payments.set(payment.id, payment);
    },
  };

  return repository;
};
