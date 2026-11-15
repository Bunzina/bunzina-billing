import type Elysia from 'elysia';
import { PaymentGatewayError } from '@/domain/payment/payment-gateway';
import type { createHandleNotification } from '@/application/payment/handle-notification';
import { isValidWebhookSignature } from '@/infrastructure/mercadopago/webhook-signature';

type Dependencies = {
  secret: string;
  handleNotification: ReturnType<typeof createHandleNotification>;
};

const MAX_RECORDED_BODY_BYTES = 8 * 1024;

const parseBody = (raw: string): unknown => {
  if (raw.length > MAX_RECORDED_BODY_BYTES) {
    return { truncated: raw.slice(0, MAX_RECORDED_BODY_BYTES) };
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

export const webhookRoutes =
  ({ secret, handleNotification }: Dependencies) =>
  (app: Elysia) =>
    app.post(
      '/webhooks/mercadopago',
      async ({ request }) => {
        const url = new URL(request.url);
        const notificationId =
          url.searchParams.get('data.id') ?? url.searchParams.get('data_id');
        const requestId = request.headers.get('x-request-id');
        const signatureHeader = request.headers.get('x-signature');
        const authentic = isValidWebhookSignature({
          secret,
          signatureHeader,
          requestId,
          dataId: notificationId,
        });

        const received = {
          query: Object.fromEntries(url.searchParams),
          headers: {
            'x-request-id': requestId,
            'x-signature': signatureHeader,
          },
          body: parseBody(await request.text()),
        };

        try {
          const outcome = await handleNotification(
            authentic && notificationId
              ? { authentic, notificationId, received }
              : { authentic: false, received },
          );

          return outcome === 'rejected'
            ? Response.json({ message: 'Invalid signature' }, { status: 401 })
            : Response.json({ status: 'ok' });
        } catch (error) {
          if (error instanceof PaymentGatewayError) {
            return Response.json(
              { message: 'Payment provider unavailable' },
              { status: 502 },
            );
          }
          throw error;
        }
      },
      {
        parse: 'none',
        detail: {
          tags: ['Webhooks'],
          summary: 'Notificação do Mercado Pago',
          description:
            'Valida o x-signature, consulta o estado na API do Mercado Pago e confirma o pagamento uma única vez.',
        },
      },
    );
