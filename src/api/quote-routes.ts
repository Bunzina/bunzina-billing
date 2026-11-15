import type Elysia from 'elysia';
import { z } from 'zod';
import {
  createDecideQuote,
  decisionSchema,
} from '@/application/quote/decide-quote';
import { createGetQuote } from '@/application/quote/get-quote';
import type { PaymentRepository } from '@/domain/payment/payment-repository';
import type { QuoteRepository } from '@/domain/quote/quote-repository';
import type { MessageStore } from '@/infrastructure/messaging/message-store';
import { errorResponse, quoteResponse } from './openapi-docs';

type Dependencies = {
  quotes: QuoteRepository;
  payments: PaymentRepository;
  store: MessageStore;
  clock: () => Date;
};

const notFound = () =>
  Response.json({ message: 'Quote not found' }, { status: 404 });

export const quoteRoutes = (dependencies: Dependencies) => {
  const getQuote = createGetQuote(dependencies);
  const decideQuote = createDecideQuote(dependencies);

  return (app: Elysia) =>
    app
      .get(
        '/quotes/:id',
        async ({ params, request }) => {
          const quote = await getQuote(
            params.id,
            request.headers.get('x-customer-document'),
          );

          return quote ? Response.json(quote) : notFound();
        },
        {
          headers: z.object({
            'x-customer-document': z
              .string()
              .describe('Documento (CPF/CNPJ) do cliente dono do orçamento'),
          }),
          error: ({ code }) => (code === 'VALIDATION' ? notFound() : undefined),
          detail: {
            tags: ['Quotes'],
            summary: 'Consulta o orçamento',
            description:
              'Devolve itens, totais, situação e o link de pagamento quando existe. O documento do cliente vai no header `X-Customer-Document`; documento divergente, ausente ou id inválido respondem 404. Um orçamento emitido e vencido aparece como `EXPIRED`.',
            responses: {
              200: quoteResponse('Orçamento do cliente', true),
              404: errorResponse(
                'Orçamento inexistente, de outro cliente ou id inválido',
              ),
            },
          },
        },
      )
      .post(
        '/quotes/:id/approval',
        async ({ params, body }) => {
          const parsed = decisionSchema.safeParse(body);

          if (!parsed.success) {
            return Response.json(
              { message: 'Invalid decision' },
              { status: 400 },
            );
          }

          const result = await decideQuote(params.id, parsed.data);

          if (result.outcome === 'not-found') {
            return notFound();
          }

          if (result.outcome === 'conflict') {
            return Response.json(
              { message: 'Quote can no longer be decided' },
              { status: 409 },
            );
          }

          return Response.json(result.quote);
        },
        {
          detail: {
            tags: ['Quotes'],
            summary: 'Aprova ou recusa o orçamento',
            description:
              'Corpo com o documento do cliente e a decisão. Documento divergente responde 404; orçamento que já não está emitido, ou vencido, responde 409.',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['document', 'decision'],
                    properties: {
                      document: {
                        type: 'string',
                        description: 'Documento (CPF/CNPJ) do cliente',
                      },
                      decision: {
                        type: 'string',
                        enum: ['APPROVED', 'REJECTED'],
                      },
                    },
                  },
                },
              },
            },
            responses: {
              200: quoteResponse('Orçamento com a decisão aplicada'),
              400: errorResponse('Corpo inválido'),
              404: errorResponse(
                'Orçamento inexistente ou documento divergente',
              ),
              409: errorResponse(
                'O orçamento não pode mais ser decidido (já decidido, cancelado ou vencido)',
              ),
            },
          },
        },
      );
};
