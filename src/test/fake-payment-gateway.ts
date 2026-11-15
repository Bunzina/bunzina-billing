import {
  type Checkout,
  type CheckoutRequest,
  type PaymentGateway,
} from '@/domain/payment/payment-gateway';

export const createFakePaymentGateway = () => {
  const calls: CheckoutRequest[] = [];
  const failures: Error[] = [];

  const gateway: PaymentGateway & {
    calls: CheckoutRequest[];
    failNext: (...errors: Error[]) => void;
  } = {
    async createCheckout(request): Promise<Checkout> {
      calls.push(request);

      const failure = failures.shift();

      if (failure) {
        throw failure;
      }

      return {
        providerPaymentId: `ORDFAKE${calls.length}`,
        checkoutUrl: `https://checkout.fake/${request.paymentId}`,
      };
    },
    calls,
    failNext: (...errors) => {
      failures.push(...errors);
    },
  };

  return gateway;
};
