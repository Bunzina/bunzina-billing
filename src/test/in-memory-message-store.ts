import type { Envelope } from '@/infrastructure/messaging/envelope';
import type {
  MessageStore,
  OutboxRow,
  Tx,
} from '@/infrastructure/messaging/message-store';

type StoredEvent = { envelope: Envelope; published: boolean };

export const createInMemoryMessageStore = () => {
  let processed = new Set<string>();
  let outbox: StoredEvent[] = [];
  const locked = new Set<string>();

  const store: MessageStore = {
    async transact<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      const snapshot = {
        processed: new Set(processed),
        outbox: outbox.map((event) => ({ ...event })),
      };
      const locks: string[] = [];
      const tx = { locks } as unknown as Tx;

      try {
        return await fn(tx);
      } catch (error) {
        processed = snapshot.processed;
        outbox = snapshot.outbox;
        throw error;
      } finally {
        for (const eventId of locks) {
          locked.delete(eventId);
        }
      }
    },

    async claimEvent(_tx, eventId, consumer) {
      const key = `${consumer}:${eventId}`;

      if (processed.has(key)) {
        return false;
      }

      processed.add(key);
      return true;
    },

    async enqueue(_tx, envelope) {
      outbox.push({ envelope, published: false });
    },

    async claimPending(tx, limit): Promise<OutboxRow[]> {
      const { locks } = tx as unknown as { locks: string[] };
      const rows = outbox
        .filter(
          (event) => !event.published && !locked.has(event.envelope.eventId),
        )
        .slice(0, limit);

      for (const row of rows) {
        locked.add(row.envelope.eventId);
        locks.push(row.envelope.eventId);
      }

      return rows.map((row) => ({ envelope: row.envelope }));
    },

    async markPublished(_tx, eventIds) {
      for (const event of outbox) {
        if (eventIds.includes(event.envelope.eventId)) {
          event.published = true;
        }
      }
    },

    async countPending() {
      return outbox.filter((event) => !event.published).length;
    },
  };

  return {
    store,
    processedCount: () => processed.size,
    outboxEvents: () => outbox.map((event) => event.envelope),
    pendingEvents: () =>
      outbox.filter((event) => !event.published).map((event) => event.envelope),
  };
};
