import type { PaymentReader } from '@/domain/payment/payment-reader';

export const createInMemoryPaymentReader = () => {
  const confirmed = new Set<string>();

  const reader: PaymentReader & { confirm: (quoteId: string) => void } = {
    async hasConfirmedPayment(_tx, quoteId) {
      return confirmed.has(quoteId);
    },

    confirm: (quoteId) => {
      confirmed.add(quoteId);
    },
  };

  return reader;
};
