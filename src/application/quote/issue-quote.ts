import logger from '@lucas-pmelo/logger';
import { z } from 'zod';
import { issueQuote, type Quote } from '@/domain/quote/quote';
import type { QuoteMailer } from '@/domain/quote/quote-mailer';
import type { QuoteRepository } from '@/domain/quote/quote-repository';
import {
  InvalidMessageError,
  type MessageHandler,
} from '@/infrastructure/messaging/consumer';
import {
  emailFailuresTotal,
  quotesTotal,
} from '@/infrastructure/observability/metrics';

const commandSchema = z.object({
  serviceOrderId: z.uuid(),
  customer: z.object({
    id: z.uuid(),
    name: z.string().min(1),
    document: z.string().min(1),
    email: z.string().min(1),
  }),
  items: z.object({
    services: z.array(
      z.object({
        serviceId: z.uuid(),
        description: z.string().min(1),
        priceCents: z.number().int().nonnegative(),
      }),
    ),
    autoParts: z.array(
      z.object({
        autoPartId: z.uuid(),
        description: z.string().min(1),
        quantity: z.number().int().positive(),
        unitPriceCents: z.number().int().nonnegative(),
      }),
    ),
  }),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

const quoteIssuedData = (quote: Quote) => ({
  serviceOrderId: quote.serviceOrderId,
  quoteId: quote.id,
  servicesTotalCents: quote.servicesTotalCents,
  autoPartsTotalCents: quote.autoPartsTotalCents,
  totalCents: quote.totalCents,
  currency: quote.currency,
  expiresAt: quote.expiresAt.toISOString(),
});

type Dependencies = {
  quotes: QuoteRepository;
  mailer: QuoteMailer;
  clock: () => Date;
  validityHours: number;
};

export const createIssueQuoteHandler =
  ({ quotes, mailer, clock, validityHours }: Dependencies): MessageHandler =>
  async ({ envelope, tx, emit, afterCommit }) => {
    const parsed = commandSchema.safeParse(envelope.data);

    if (!parsed.success) {
      throw new InvalidMessageError(z.prettifyError(parsed.error));
    }

    const quote = issueQuote({
      ...parsed.data,
      now: clock(),
      validityHours,
    });

    if (!Number.isSafeInteger(quote.totalCents) || quote.totalCents <= 0) {
      throw new InvalidMessageError('quote total must be greater than zero');
    }

    const active = await quotes.findActiveByServiceOrder(
      tx,
      quote.serviceOrderId,
    );

    if (active) {
      await emit('evt.billing.quote-issued', quoteIssuedData(active));
      return;
    }

    await quotes.insert(tx, quote);

    await emit('evt.billing.quote-issued', quoteIssuedData(quote));

    afterCommit(async () => {
      quotesTotal.inc({ status: quote.status });

      try {
        await mailer.sendQuoteIssued(quote);
      } catch (error) {
        emailFailuresTotal.inc({ template: 'quote-issued' });
        logger.warn({
          message: 'failed to email the quote',
          quoteId: quote.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  };
