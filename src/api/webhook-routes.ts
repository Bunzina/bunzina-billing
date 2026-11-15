import logger from '@lucas-pmelo/logger';
import type Elysia from 'elysia';
import { PaymentGatewayError } from '@/domain/payment/payment-gateway';
import type { createHandleNotification } from '@/application/payment/handle-notification';
import { errorResponse } from './openapi-docs';
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
            logger.warn({
              message: 'payment provider failed while handling a notification',
              notificationId,
              providerStatus: error.providerStatus,
              retryable: error.retryable,
              error: error.message,
            });
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
            'Valida o x-signature (HMAC-SHA256 do manifest `id;request-id;ts`), consulta o estado na API do Mercado Pago e confirma o pagamento uma única vez. O corpo nunca decide nada; o id da notificação vem em `data_id` na query (o formato `data.id` também é aceito).',
          parameters: [
            {
              name: 'data_id',
              in: 'query',
              required: true,
              schema: { type: 'string' },
              description: 'Id da merchant_order notificada',
            },
            {
              name: 'x-signature',
              in: 'header',
              required: true,
              schema: { type: 'string' },
              description: 'Assinatura no formato `ts=...,v1=...`',
            },
            {
              name: 'x-request-id',
              in: 'header',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            200: {
              description:
                'Notificação processada, ou sem Pagamento correspondente (não adianta repetir)',
            },
            401: errorResponse('Assinatura ausente ou inválida'),
            502: errorResponse(
              'Mercado Pago indisponível; ele entrega a notificação de novo',
            ),
          },
        },
      },
    );
