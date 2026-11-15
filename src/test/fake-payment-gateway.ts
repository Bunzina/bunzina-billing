import {
  type Checkout,
  type CheckoutRequest,
  type RefundRequest,
  type PaymentGateway,
  type ProviderOrder,
} from '@/domain/payment/payment-gateway';

export const createFakePaymentGateway = () => {
  const calls: CheckoutRequest[] = [];
  const failures: Error[] = [];
  const lookups: string[] = [];
  const references = new Map<string, string>();
  const orders = new Map<string, ProviderOrder>();
  const expired: string[] = [];
  const refunds: RefundRequest[] = [];
  const refundFailures: Error[] = [];
  const expirationFailures: Error[] = [];
  let lookupFailure: Error | null = null;

  const gateway: PaymentGateway & {
    calls: CheckoutRequest[];
    lookups: string[];
    expired: string[];
    refunds: RefundRequest[];
    failRefunds: (...errors: Error[]) => void;
    failExpirations: (...errors: Error[]) => void;
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
    async expireCheckout(providerPaymentId) {
      const failure = expirationFailures.shift();
      if (failure) {
        throw failure;
      }
      expired.push(providerPaymentId);
    },
    async refund(request) {
      const failure = refundFailures.shift();
      if (failure) {
        throw failure;
      }
      refunds.push(request);
      return { providerRefundId: `REFFAKE${refunds.length}` };
    },
    calls,
    lookups,
    expired,
    refunds,
    failRefunds: (...errors) => {
      refundFailures.push(...errors);
    },
    failExpirations: (...errors) => {
      expirationFailures.push(...errors);
    },
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
