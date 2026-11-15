import {
  type Checkout,
  type CheckoutRequest,
  type PaymentGateway,
  type ProviderOrder,
} from '@/domain/payment/payment-gateway';

export const createFakePaymentGateway = () => {
  const calls: CheckoutRequest[] = [];
  const failures: Error[] = [];
  const lookups: string[] = [];
  const references = new Map<string, string>();
  const orders = new Map<string, ProviderOrder>();
  let lookupFailure: Error | null = null;

  const gateway: PaymentGateway & {
    calls: CheckoutRequest[];
    lookups: string[];
    failNext: (...errors: Error[]) => void;
    failLookups: (error: Error | null) => void;
    knowNotification: (notificationId: string, paymentId: string) => void;
    setOrder: (providerPaymentId: string, order: ProviderOrder) => void;
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
    async findPaymentReference(notificationId) {
      lookups.push(notificationId);
      if (lookupFailure) {
        throw lookupFailure;
      }
      return references.get(notificationId) ?? null;
    },
    async getOrder(providerPaymentId) {
      lookups.push(providerPaymentId);
      if (lookupFailure) {
        throw lookupFailure;
      }
      return orders.get(providerPaymentId) ?? { state: 'OPEN' };
    },
    calls,
    lookups,
    failNext: (...errors) => {
      failures.push(...errors);
    },
    failLookups: (error) => {
      lookupFailure = error;
    },
    knowNotification: (notificationId, paymentId) => {
      references.set(notificationId, paymentId);
    },
    setOrder: (providerPaymentId, order) => {
      orders.set(providerPaymentId, order);
    },
  };

  return gateway;
};
