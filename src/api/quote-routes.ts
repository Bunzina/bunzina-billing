import type Elysia from 'elysia';
import { createGetQuote } from '@/application/quote/get-quote';
import type { QuoteRepository } from '@/domain/quote/quote-repository';

type Dependencies = {
  quotes: QuoteRepository;
  clock: () => Date;
};

const notFound = () =>
  Response.json({ message: 'Quote not found' }, { status: 404 });

export const quoteRoutes = (dependencies: Dependencies) => {
  const getQuote = createGetQuote(dependencies);

  return (app: Elysia) =>
    app.get(
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
    );
};
