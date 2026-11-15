import logger from '@lucas-pmelo/logger';
import type { Payment } from '@/domain/payment/payment';
import type { PaymentEvent } from '@/domain/payment/payment-event-log';
import type { PaymentGateway } from '@/domain/payment/payment-gateway';

type Dependencies = {
  gateway: PaymentGateway | undefined;
  record: (event: PaymentEvent) => Promise<void>;
};

export const expireCheckout = async (
  { gateway, record }: Dependencies,
  payment: Payment,
): Promise<void> => {
  const { providerPaymentId } = payment;

  if (!providerPaymentId) {
    return;
  }

  try {
    if (!gateway) {
      throw new Error('payment gateway is not configured');
    }

    await gateway.expireCheckout(providerPaymentId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    logger.warn({
      message: 'failed to expire the checkout at the payment provider',
      paymentId: payment.id,
      error: message,
    });

    await record({
      paymentId: payment.id,
      type: 'checkout-expiry-failed',
      payload: { providerPaymentId, error: message },
    });
  }
};
