import { z } from 'zod';

export const envelopeSchema = z.object({
  eventId: z.uuid(),
  eventType: z.string().regex(/^(cmd|evt)\.[a-z]+\.[a-z0-9-]+$/),
  eventVersion: z.number().int().positive(),
  occurredAt: z.iso.datetime(),
  correlationId: z.uuid(),
  causationId: z.uuid().optional(),
  producer: z.string().min(1),
  traceparent: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
});

export type Envelope<TData = Record<string, unknown>> = Omit<
  z.infer<typeof envelopeSchema>,
  'data'
> & { data: TData };

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
