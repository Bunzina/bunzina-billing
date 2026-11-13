import { context, propagation } from '@opentelemetry/api';
import type { TransactionSQL } from 'bun';
import { db } from '@/infrastructure/configs/database';
import type { Envelope } from './envelope';

export type Tx = TransactionSQL;

export type OutboxRow = { envelope: Envelope };

export interface MessageStore {
  transact<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  claimEvent(tx: Tx, eventId: string, consumer: string): Promise<boolean>;
  enqueue(tx: Tx, envelope: Envelope): Promise<void>;
  claimPending(tx: Tx, limit: number): Promise<OutboxRow[]>;
  markPublished(tx: Tx, eventIds: string[]): Promise<void>;
  countPending(): Promise<number>;
}

export const postgresMessageStore: MessageStore = {
  transact: (fn) => db.transaction(fn),

  async claimEvent(tx, eventId, consumer) {
    const rows = await tx`
      INSERT INTO bunzina.processed_events (event_id, consumer)
      VALUES (${eventId}, ${consumer})
      ON CONFLICT (event_id, consumer) DO NOTHING
      RETURNING event_id
    `;

    return rows.length > 0;
  },

  async enqueue(tx, envelope) {
    const headers: Record<string, string> = {};
    propagation.inject(context.active(), headers);

    const payload = JSON.stringify({
      ...envelope,
      traceparent: headers.traceparent,
    });

    await tx`
      INSERT INTO bunzina.outbox_messages
        (event_id, event_type, correlation_id, payload)
      VALUES
        (${envelope.eventId}, ${envelope.eventType}, ${envelope.correlationId}, ${payload}::jsonb)
    `;
  },

  async claimPending(tx, limit) {
    const rows = await tx`
      SELECT payload
      FROM bunzina.outbox_messages
      WHERE published_at IS NULL
      ORDER BY created_at, event_id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;

    return rows.map((row: { payload: Envelope }) => ({
      envelope: row.payload,
    }));
  },

  async markPublished(tx, eventIds) {
    if (eventIds.length === 0) {
      return;
    }

    await tx`
      UPDATE bunzina.outbox_messages
      SET published_at = now()
      WHERE event_id IN ${tx(eventIds)}
    `;
  },

  async countPending() {
    const [row] = await db`
      SELECT count(*)::int AS count
      FROM bunzina.outbox_messages
      WHERE published_at IS NULL
    `;

    return Number(row?.count ?? 0);
  },
};
