import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';

const registry = new Registry();

collectDefaultMetrics({ register: registry });

export const httpRequestsTotal = new Counter({
  name: 'bunzina_billing_http_requests_total',
  help: 'Total number of HTTP requests handled by the service.',
  labelNames: ['method', 'route', 'status_code'],
  registers: [registry],
});

export const httpRequestDurationSeconds = new Histogram({
  name: 'bunzina_billing_http_request_duration_seconds',
  help: 'HTTP request duration in seconds.',
  labelNames: ['method', 'route', 'status_code'],
  registers: [registry],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
});

export const httpRequestsInFlight = new Gauge({
  name: 'bunzina_billing_http_requests_in_flight',
  help: 'Number of HTTP requests currently being handled.',
  registers: [registry],
});

// Métricas de mensageria. Alimentam o dashboard da saga no Grafana: volume por
// tipo de mensagem, falha de consumo e descarte por idempotência.
export const messagesPublishedTotal = new Counter({
  name: 'bunzina_billing_messages_published_total',
  help: 'Total number of messages published to the broker.',
  labelNames: ['event_type'],
  registers: [registry],
});

export const messagesConsumedTotal = new Counter({
  name: 'bunzina_billing_messages_consumed_total',
  help: 'Total number of messages consumed from the broker.',
  labelNames: ['event_type', 'result'],
  registers: [registry],
});

export const messageHandlingDurationSeconds = new Histogram({
  name: 'bunzina_billing_message_handling_duration_seconds',
  help: 'Time spent handling a consumed message, in seconds.',
  labelNames: ['event_type'],
  registers: [registry],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
});

const getStatusCode = (status: number | string | undefined): string => {
  const statusCode = Number(status);
  return Number.isInteger(statusCode) && statusCode > 0
    ? String(statusCode)
    : '200';
};

// Cada serviço acrescenta aqui os seus próprios padrões de rota dinâmica. Sem
// normalizar, um id por request vira uma série temporal por request.
const dynamicRoutePatterns: Array<[RegExp, string]> = [];

export const normalizeRoute = (pathname: string): string => {
  for (const [pattern, route] of dynamicRoutePatterns) {
    if (pattern.test(pathname)) {
      return route;
    }
  }

  return pathname || '/';
};

const getRequestLabels = (
  request: Request,
  status: number | string | undefined,
) => {
  const url = new URL(request.url);

  return {
    method: request.method,
    route: normalizeRoute(url.pathname),
    status_code: getStatusCode(status),
  };
};

export const createHttpMetrics = () => {
  const requestStartTimes = new WeakMap<Request, number>();

  return {
    start(request: Request) {
      requestStartTimes.set(request, performance.now());
      httpRequestsInFlight.inc();
    },
    finish(request: Request, status: number | string | undefined) {
      const labels = getRequestLabels(request, status);
      const startedAt = requestStartTimes.get(request);
      const durationSeconds = startedAt
        ? (performance.now() - startedAt) / 1000
        : 0;

      httpRequestsTotal.inc(labels);
      httpRequestDurationSeconds.observe(labels, durationSeconds);
      httpRequestsInFlight.dec();
      requestStartTimes.delete(request);
    },
  };
};

export const metricsContentType = 'text/plain; version=0.0.4; charset=utf-8';

export const getMetrics = async (): Promise<string> => registry.metrics();
