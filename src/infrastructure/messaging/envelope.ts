import { z } from 'zod';

/**
 * Envelope único de comandos e eventos, conforme
 * docs/contracts/events-saga-contracts.md do repositório `bunzina`.
 *
 * Os quatro serviços precisam validar com este mesmo schema — é o critério de
 * aceite nº 1 do contrato.
 */
export const envelopeSchema = z.object({
  /** UUID v7. Chave de idempotência, não identificador decorativo. */
  eventId: z.uuid(),
  /** `cmd.<serviço>.<ação>` ou `evt.<contexto>.<fato-no-passado>`. */
  eventType: z.string().regex(/^(cmd|evt)\.[a-z]+\.[a-z0-9-]+$/),
  eventVersion: z.number().int().positive(),
  occurredAt: z.iso.datetime(),
  /** Sempre o serviceOrderId: costura a saga inteira. */
  correlationId: z.uuid(),
  /** eventId da mensagem que causou esta. Ausente só na primeira da cadeia. */
  causationId: z.uuid().optional(),
  producer: z.string().min(1),
  /** W3C. Duplicado no header AMQP, para quem abrir a mensagem na DLQ. */
  traceparent: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
});

export type Envelope<TData = Record<string, unknown>> = Omit<
  z.infer<typeof envelopeSchema>,
  'data'
> & { data: TData };

/** Enum fechado: motivo em texto solto impede agrupar falha por causa. */
export const failureReasons = [
  'PART_UNAVAILABLE',
  'EXPIRED',
  'REJECTED',
  'TIMEOUT',
  'PROVIDER_ERROR',
  'CUSTOMER_REQUEST',
  'UNREPAIRABLE',
] as const;

export const failureReasonSchema = z.enum(failureReasons);

export type FailureReason = (typeof failureReasons)[number];

type BuildInput<TData> = {
  eventType: string;
  correlationId: string;
  data: TData;
  causationId?: string;
};

export const buildEnvelope = <TData extends Record<string, unknown>>({
  eventType,
  correlationId,
  data,
  causationId,
}: BuildInput<TData>): Envelope<TData> => ({
  eventId: Bun.randomUUIDv7(),
  eventType,
  eventVersion: 1,
  occurredAt: new Date().toISOString(),
  correlationId,
  ...(causationId ? { causationId } : {}),
  producer: process.env.OTEL_SERVICE_NAME || 'bunzina-billing',
  data,
});

export const parseEnvelope = (raw: unknown): Envelope =>
  envelopeSchema.parse(raw) as Envelope;
