import logger from '@lucas-pmelo/logger';
import { z } from 'zod';
import {
  attachCheckout,
  createPendingPayment,
  failPayment,
} from '@/domain/payment/payment';
import {
  PaymentGatewayError,
  type Checkout,
  type CheckoutRequest,
  type PaymentGateway,
} from '@/domain/payment/payment-gateway';
import type { PaymentMailer } from '@/domain/payment/payment-mailer';
import type { PaymentRepository } from '@/domain/payment/payment-repository';
import { paymentFailedData } from './payment-failed-event';
import type { QuoteRepository } from '@/domain/quote/quote-repository';
import {
  InvalidMessageError,
  type MessageHandler,
  type RetryPolicy,
} from '@/infrastructure/messaging/consumer';
import {
  emailFailuresTotal,
  paymentsTotal,
} from '@/infrastructure/observability/metrics';

const commandSchema = z.object({
  serviceOrderId: z.uuid(),
  quoteId: z.uuid(),
  totalCents: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

const createCheckoutWithRetry = async (
  gateway: PaymentGateway,
  request: CheckoutRequest,
  retry: RetryPolicy,
): Promise<Checkout> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await gateway.createCheckout(request);
    } catch (error) {
      const retryable = error instanceof PaymentGatewayError && error.retryable;

      if (!retryable || attempt >= retry.maxAttempts) {
        throw error;
      }

      await retry.sleep(retry.baseDelayMs * 2 ** (attempt - 1));
    }
  }
};

const providerStatusOf = (error: unknown): string =>
  error instanceof PaymentGatewayError ? error.providerStatus : 'unreachable';

type Dependencies = {
  quotes: QuoteRepository;
  payments: PaymentRepository;
  gateway: PaymentGateway;
  mailer: PaymentMailer;
  clock: () => Date;
  validityMinutes: number;
  retry: RetryPolicy;
};

export const createChargeHandler =
  ({
    quotes,
    payments,
    gateway,
    mailer,
    clock,
    validityMinutes,
    retry,
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

    if (quote.status !== 'APPROVED') {
      throw new InvalidMessageError(
        `a ${quote.status} quote cannot be charged`,
      );
    }

    if (
      quote.totalCents !== parsed.data.totalCents ||
      quote.currency !== parsed.data.currency
    ) {
      throw new InvalidMessageError(
        'charge total does not match the approved quote',
      );
    }

    const existing = await payments.findByQuoteIdForUpdate(tx, quote.id);

    if (existing) {
      if (existing.status === 'FAILED') {
        await emit('evt.billing.payment-failed', paymentFailedData(existing));
      }

      return;
    }

    const now = clock();
    const pending = createPendingPayment({
      quoteId: quote.id,
      serviceOrderId: quote.serviceOrderId,
      amountCents: quote.totalCents,
      currency: quote.currency,
      now,
      validityMinutes,
    });

    let checkout: Checkout;

    try {
      checkout = await createCheckoutWithRetry(
        gateway,
        {
          paymentId: pending.id,
          amountCents: pending.amountCents,
          currency: pending.currency,
          description: `Orçamento ${quote.id}`,
          expiresInMinutes: validityMinutes,
        },
        retry,
      );
    } catch (error) {
      const failed = failPayment(pending, {
        reason: 'PROVIDER_ERROR',
        detail: providerStatusOf(error),
      });

      logger.error({
        message: 'payment provider failed to create the checkout',
        paymentId: failed.id,
        providerStatus: failed.failureDetail,
        error: error instanceof Error ? error.message : String(error),
      });

      await payments.insert(tx, failed);
      await emit('evt.billing.payment-failed', paymentFailedData(failed));

      afterCommit(async () => {
        paymentsTotal.inc({ status: failed.status });
      });

      return;
    }

    await payments.insert(tx, attachCheckout(pending, checkout));

    afterCommit(async () => {
      paymentsTotal.inc({ status: pending.status });

      try {
        await mailer.sendPaymentLink({
          quote,
          checkoutUrl: checkout.checkoutUrl,
          expiresAt: pending.expiresAt ?? now,
        });
      } catch (error) {
        emailFailuresTotal.inc({ template: 'payment-link' });
        logger.warn({
          message: 'failed to email the payment link',
          paymentId: pending.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  };
