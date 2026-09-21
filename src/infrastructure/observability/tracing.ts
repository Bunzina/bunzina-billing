import { opentelemetry } from '@elysiajs/opentelemetry';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { propagation } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import type { Elysia } from 'elysia';

const tracesEndpoint =
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

const NON_TRACED_PATHS = new Set(['/metrics', '/health', '/ready']);

// O propagador precisa estar registrado mesmo quando o tracing está desligado:
// é ele que o publisher e o consumer usam para injetar e extrair o traceparent
// nos headers AMQP. Sem isso o trace quebra em cada salto por RabbitMQ.
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

export const tracing: Elysia | null = tracesEndpoint ? build() : null;

function build(): Elysia {
  return opentelemetry({
    serviceName: process.env.OTEL_SERVICE_NAME || 'bunzina-billing',
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
    checkIfShouldTrace: shouldTrace,
  });
}

function shouldTrace(request: Request): boolean {
  try {
    return !NON_TRACED_PATHS.has(new URL(request.url).pathname);
  } catch {
    return true;
  }
}
