import type { Quote } from '@/domain/quote/quote';
import type { QuoteRepository } from '@/domain/quote/quote-repository';

const ACTIVE = new Set(['ISSUED', 'APPROVED']);

export const createInMemoryQuoteRepository = () => {
  const quotes = new Map<string, Quote>();

  const repository: QuoteRepository & {
    all: () => Quote[];
    save: (quote: Quote) => void;
  } = {
    async findById(id) {
      return quotes.get(id) ?? null;
    },

    async findActiveByServiceOrder(_tx, serviceOrderId) {
      return (
        [...quotes.values()].find(
          (quote) =>
            quote.serviceOrderId === serviceOrderId && ACTIVE.has(quote.status),
        ) ?? null
      );
    },

    async insert(_tx, quote) {
      quotes.set(quote.id, quote);
    },

    all: () => [...quotes.values()],
    save: (quote) => {
      quotes.set(quote.id, quote);
    },
  };

  return repository;
};
