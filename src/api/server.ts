import '@/infrastructure/observability/logger-trace';

import { createIssueQuoteHandler } from '@/application/quote/issue-quote';
import { parseValidityHours } from '@/domain/quote/quote';
import { db } from '@/infrastructure/configs/database';
import {
  DEFAULT_EMAIL,
  emailTransporter,
} from '@/infrastructure/configs/email-transporter';
import { createNodemailerQuoteMailer } from '@/infrastructure/email/nodemailer-quote-mailer';
import { startConsumer } from '@/infrastructure/messaging/consumer';
import { postgresQuoteRepository } from '@/infrastructure/persistence/postgres-quote-repository';
import { quoteRoutes } from './quote-routes';
import { startRelay } from '@/infrastructure/messaging/outbox-relay';
import {
  createHttpMetrics,
  getMetrics,
  metricsContentType,
} from '@/infrastructure/observability/metrics';
import { tracing } from '@/infrastructure/observability/tracing';
import openapi from '@elysiajs/openapi';
import Elysia from 'elysia';
import logger from '@lucas-pmelo/logger';
import z from 'zod';

export const app = new Elysia();

if (tracing) {
  app.use(tracing);
}

const httpMetrics = createHttpMetrics();

app.onRequest(({ request }) => {
  if (new URL(request.url).pathname !== '/metrics') {
    httpMetrics.start(request);
  }
});

app.onAfterHandle(({ request, set, responseValue }) => {
  if (new URL(request.url).pathname !== '/metrics') {
    const status =
      responseValue instanceof Response ? responseValue.status : set.status;
    httpMetrics.finish(request, status);
  }
});

app.onError(({ request, set, error }) => {
  if (new URL(request.url).pathname !== '/metrics') {
    const status = (error as { status?: number })?.status ?? set.status ?? 500;
    httpMetrics.finish(request, status);
  }
});

app.use(
  openapi({
    documentation: {
      info: {
        title: 'bunzina-billing API',
        version: '1.0.0',
        description: 'Microsserviço do Bunzina — Fase 4.',
      },
      tags: [
        { name: 'Health', description: 'Verificação de saúde do serviço' },
        { name: 'Quotes', description: 'Orçamentos emitidos pelo Billing' },
      ],
    },
    path: '/swagger',
    mapJsonSchema: { zod: z.toJSONSchema },
  }),
);

app.get('/health', () => Response.json({ status: 'ok' }), {
  detail: { tags: ['Health'] },
});

app.get('/metrics', async () => {
  return new Response(await getMetrics(), {
    status: 200,
    headers: { 'Content-Type': metricsContentType },
  });
});

app.get('/ready', async ({ set }) => {
  try {
    await checkDependencies();

    return Response.json({ status: 'ready' });
  } catch {
    set.status = 503;

    return Response.json({ status: 'not_ready' }, { status: 503 });
  }
});

async function checkDependencies(): Promise<void> {
  await db`SELECT 1`;
}

const clock = () => new Date();

app.use(quoteRoutes({ quotes: postgresQuoteRepository, clock }));

app.get('/', ({ redirect }) => redirect('/swagger'), {
  detail: { hide: true },
});

/* c8 ignore next */
if (import.meta.main) {
  app.listen(3000, () => {
    logger.info({
      message: 'Server is running on http://localhost:3000/swagger',
    });
  });

  if (process.env.RABBITMQ_URL) {
    void startConsumer({
      bindings: ['cmd.billing.*'],
      handlers: {
        'cmd.billing.issue-quote': createIssueQuoteHandler({
          quotes: postgresQuoteRepository,
          mailer: createNodemailerQuoteMailer({
            transporter: emailTransporter,
            from: DEFAULT_EMAIL,
          }),
          clock,
          validityHours: parseValidityHours(process.env.QUOTE_VALIDITY_HOURS),
        }),
      },
    }).catch((error: unknown) => {
      logger.error({
        message: 'failed to start the consumer',
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    });

    const relay = startRelay();

    process.once('SIGTERM', () => {
      void relay.stop().then(() => process.exit(0));
    });
  }
}
