import {
  PaymentGatewayError,
  type PaymentGateway,
  type ProviderOrder,
} from '@/domain/payment/payment-gateway';
import { mercadopagoRequestDurationSeconds } from '@/infrastructure/observability/metrics';

const DEFAULT_BASE_URL = 'https://api.mercadopago.com';
const REQUEST_TIMEOUT_MS = 10_000;
const SUPPORTED_CURRENCY = 'BRL';

type Input = {
  accessToken: string;
  baseUrl?: string;
  fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>;
};

const toProviderAmount = (cents: number): string =>
  `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

const isRetryableStatus = (status: number): boolean =>
  status === 429 || status >= 500;

type ProviderPayment = {
  status?: unknown;
  status_detail?: unknown;
  payment_method?: { id?: unknown; type?: unknown };
};

type ProviderOrderBody = {
  status?: unknown;
  status_detail?: unknown;
  last_updated_date?: unknown;
  transactions?: { payments?: ProviderPayment[] };
};

const invalidResponse = (operation: string) =>
  new PaymentGatewayError(
    `mercadopago ${operation} answered an unexpected body`,
    false,
    'invalid_response',
  );

const methodOf = (payment?: ProviderPayment): string => {
  const { id, type } = payment?.payment_method ?? {};
  if (id === 'pix') {
    return 'pix';
  }
  return typeof type === 'string' ? type : 'unknown';
};

const toProviderOrder = (body: ProviderOrderBody): ProviderOrder => {
  const payments = body.transactions?.payments ?? [];
  if (body.status === 'processed' && body.status_detail === 'accredited') {
    const paidAt = new Date(String(body.last_updated_date));
    if (Number.isNaN(paidAt.getTime())) {
      throw invalidResponse('get_order');
    }
    return { state: 'PAID', method: methodOf(payments[0]), paidAt };
  }
  const declined = payments.findLast((payment) => payment.status === 'failed');
  if (declined) {
    return { state: 'DECLINED', detail: String(declined.status_detail) };
  }
  return { state: 'OPEN' };
};

export const createMercadoPagoPaymentGateway = ({
  accessToken,
  baseUrl = DEFAULT_BASE_URL,
  fetch: fetchImpl = fetch,
}: Input): PaymentGateway => {
  const call = async <T>(
    operation: string,
    path: string,
    init: RequestInit,
    parse: (response: Response) => Promise<T>,
    {
      retryNotFound = false,
      tolerate,
    }: {
      retryNotFound?: boolean;
      tolerate?: (response: Response) => Promise<boolean>;
    } = {},
  ): Promise<T> => {
    const stopTimer = mercadopagoRequestDurationSeconds.startTimer({
      operation,
    });
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${accessToken}`, ...init.headers },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }).catch(() => {
        throw new PaymentGatewayError(
          `mercadopago ${operation} is unreachable`,
          true,
          'unreachable',
        );
      });
      if (!response.ok && !(await tolerate?.(response))) {
        throw new PaymentGatewayError(
          `mercadopago ${operation} answered ${response.status}`,
          isRetryableStatus(response.status) ||
            (retryNotFound && response.status === 404),
          `http_${response.status}`,
        );
      }
      const result = await parse(response);
      stopTimer({ result: 'success' });
      return result;
    } catch (error) {
      stopTimer({ result: 'error' });
      throw error;
    }
  };

  return {
    expireCheckout: (providerPaymentId) =>
      call(
        'cancel_order',
        `/v1/orders/${encodeURIComponent(providerPaymentId)}/cancel`,
        {
          method: 'POST',
          headers: { 'X-Idempotency-Key': crypto.randomUUID() },
        },
        async () => undefined,
        {
          tolerate: async (response) => {
            const body = (await response.json().catch(() => null)) as {
              errors?: { code?: unknown }[];
            } | null;

            return (
              response.status === 409 &&
              body?.errors?.[0]?.code === 'order_already_canceled'
            );
          },
        },
      ),

    findPaymentReference: (notificationId) =>
      call(
        'get_merchant_order',
        `/merchant_orders/${encodeURIComponent(notificationId)}`,
        { method: 'GET' },
        async (response) => {
          const body = (await response.json().catch(() => null)) as {
            external_reference?: unknown;
          } | null;

          return typeof body?.external_reference === 'string' &&
            body.external_reference
            ? body.external_reference
            : null;
        },
        { retryNotFound: true },
      ),

    getOrder: (providerPaymentId) =>
      call(
        'get_order',
        `/v1/orders/${encodeURIComponent(providerPaymentId)}`,
        { method: 'GET' },
        async (response) => {
          const body = (await response
            .json()
            .catch(() => null)) as ProviderOrderBody | null;
          if (!body || typeof body.status !== 'string') {
            throw invalidResponse('get_order');
          }

          return toProviderOrder(body);
        },
      ),

    async createCheckout(request) {
      if (request.currency !== SUPPORTED_CURRENCY) {
        throw new PaymentGatewayError(
          `mercadopago create_order does not support ${request.currency}`,
          false,
          'unsupported_currency',
        );
      }
      const amount = toProviderAmount(request.amountCents);

      return call(
        'create_order',
        '/v1/orders',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Idempotency-Key': request.paymentId,
          },
          body: JSON.stringify({
            type: 'online',
            processing_mode: 'manual',
            total_amount: amount,
            external_reference: request.paymentId,
            expiration_time: `PT${request.expiresInMinutes}M`,
            items: [
              { title: request.description, unit_price: amount, quantity: 1 },
            ],
            config: { payment_method: { not_allowed_types: ['ticket'] } },
          }),
        },
        async (response) => {
          const order = (await response.json().catch(() => null)) as {
            id?: unknown;
            checkout_url?: unknown;
          } | null;
          if (
            typeof order?.id !== 'string' ||
            typeof order.checkout_url !== 'string'
          ) {
            throw new PaymentGatewayError(
              'mercadopago create_order answered without an order id or checkout link',
              false,
              'invalid_response',
            );
          }

          return {
            providerPaymentId: order.id,
            checkoutUrl: order.checkout_url,
          };
        },
      );
    },
  };
};
