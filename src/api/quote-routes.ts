import type Elysia from 'elysia';
import {
  createDecideQuote,
  decisionSchema,
} from '@/application/quote/decide-quote';
import { createGetQuote } from '@/application/quote/get-quote';
import type { QuoteRepository } from '@/domain/quote/quote-repository';
import type { MessageStore } from '@/infrastructure/messaging/message-store';

type Dependencies = {
  quotes: QuoteRepository;
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
          detail: {
            tags: ['Quotes'],
            summary: 'Consulta o orçamento',
            description:
              'Devolve itens, totais e situação. O documento do cliente vai no header; documento divergente responde 404.',
            parameters: [
              {
                name: 'X-Customer-Document',
                in: 'header',
                required: true,
                schema: { type: 'string' },
              },
            ],
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
              'Corpo com o documento do cliente e a decisão. Documento divergente responde 404.',
          },
        },
      );
};
