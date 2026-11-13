import type { Quote } from '@/domain/quote/quote';
import type { QuoteMailer } from '@/domain/quote/quote-mailer';

export const createFakeMailer = () => {
  const sent: Quote[] = [];
  let failure: Error | null = null;

  const mailer: QuoteMailer & {
    sent: Quote[];
    failWith: (error: Error | null) => void;
  } = {
    async sendQuoteIssued(quote) {
      if (failure) {
        throw failure;
      }

      sent.push(quote);
    },
    sent,
    failWith: (error) => {
      failure = error;
    },
  };

  return mailer;
};
