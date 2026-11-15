import { z } from 'zod';
import { cancelQuote, type Quote } from '@/domain/quote/quote';
import { failPayment } from '@/domain/payment/payment';
import type { PaymentEventLog } from '@/domain/payment/payment-event-log';
import type { PaymentGateway } from '@/domain/payment/payment-gateway';
import type { PaymentRepository } from '@/domain/payment/payment-repository';
import type { QuoteRepository } from '@/domain/quote/quote-repository';
import {
  InvalidMessageError,
  type MessageHandler,
} from '@/infrastructure/messaging/consumer';
import {
  paymentsTotal,
  quotesTotal,
} from '@/infrastructure/observability/metrics';
import { expireCheckout } from '@/application/payment/expire-checkout';

const commandSchema = z.object({
  serviceOrderId: z.uuid(),
  quoteId: z.uuid(),
  reason: z.string().min(1),
  detail: z.string().optional(),
});

const quoteCanceledData = (quote: Quote) => ({
  serviceOrderId: quote.serviceOrderId,
  quoteId: quote.id,
  canceledAt: quote.canceledAt?.toISOString(),
});

type Dependencies = {
  quotes: QuoteRepository;
  payments: PaymentRepository;
  events: PaymentEventLog;
  gateway: PaymentGateway | undefined;
  clock: () => Date;
};

export const createCancelQuoteHandler =
  ({
    quotes,
    payments,
    events,
    gateway,
    clock,
  }: Dependencies): MessageHandler =>
  async ({ envelope, tx, emit, afterCommit }) => {
    const parsed = commandSchema.safeParse(envelope.data);

    if (!parsed.success) {
      throw new InvalidMessageError(z.prettifyError(parsed.error));
    }

    const quote = await quotes.findByIdForUpdate(tx, parsed.data.quoteId);

    if (!quote || quote.serviceOrderId !== parsed.data.serviceOrderId) {
      throw new InvalidMessageError('quote not found for the service order');
    }

    if (quote.status === 'CANCELED') {
      await emit('evt.billing.quote-canceled', quoteCanceledData(quote));
      return;
    }

    if (quote.status === 'REJECTED') {
      throw new InvalidMessageError(
        `a ${quote.status} quote cannot be canceled`,
      );
    }

    const payment = await payments.findByQuoteIdForUpdate(tx, quote.id);

    if (payment?.status === 'CONFIRMED') {
      throw new InvalidMessageError(
        'quote has a confirmed payment and needs a refund, not a cancellation',
      );
    }

    const canceled = cancelQuote(quote, { now: clock() });

    await quotes.update(tx, canceled);

    if (payment?.status === 'PENDING') {
      const failed = failPayment(payment, {
        reason: 'TIMEOUT',
        detail: 'quote-canceled',
      });

      if (await payments.failIfPending(tx, failed)) {
        await events.record(tx, {
          paymentId: payment.id,
          type: 'payment-canceled',
          payload: { quoteId: quote.id },
        });
        await expireCheckout(
          { gateway, record: (event) => events.record(tx, event) },
          payment,
        );

        afterCommit(async () => {
          paymentsTotal.inc({ status: failed.status });
        });
      }
    }

    await emit('evt.billing.quote-canceled', quoteCanceledData(canceled));

    afterCommit(async () => {
      quotesTotal.inc({ status: canceled.status });
    });
  };
