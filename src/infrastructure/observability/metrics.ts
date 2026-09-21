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

const dynamicRoutePatterns: Array<[RegExp, string]> = [];

const UUID_SEGMENT =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export const normalizeRoute = (pathname: string): string => {
  for (const [pattern, route] of dynamicRoutePatterns) {
    if (pattern.test(pathname)) {
      return route;
    }
  }

  return pathname.replace(UUID_SEGMENT, ':id') || '/';
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
