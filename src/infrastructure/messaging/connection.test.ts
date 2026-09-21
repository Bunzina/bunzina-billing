import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const assertExchange = mock(async () => ({}) as never);
const assertQueue = mock(async () => ({}) as never);
const bindQueue = mock(async () => ({}) as never);
const prefetch = mock(async () => 0);
const closeChannel = mock(async () => {});
const closeConnectionMock = mock(async () => {});
const createChannel = mock(async () => ({
  assertExchange,
  assertQueue,
  bindQueue,
  prefetch,
  close: closeChannel,
}));

mock.module('amqplib', () => ({
  default: {
    connect: mock(async () => ({
      createChannel,
      close: closeConnectionMock,
    })),
  },
}));

const { closeConnection, DLQ, DLX, EXCHANGE, getChannel, QUEUE } =
  await import('./connection');

beforeEach(() => {
  process.env.RABBITMQ_URL = 'amqp://localhost';
});

afterEach(async () => {
  await closeConnection();
});

describe('getChannel', () => {
  it('declares the topic exchange and the dead letter exchange', async () => {
    await getChannel();

    expect(assertExchange).toHaveBeenCalledWith(EXCHANGE, 'topic', {
      durable: true,
    });
    expect(assertExchange).toHaveBeenCalledWith(DLX, 'topic', {
      durable: true,
    });
  });

  it('points the service queue at the dead letter exchange', async () => {
    await getChannel();

    expect(assertQueue).toHaveBeenCalledWith(QUEUE, {
      durable: true,
      deadLetterExchange: DLX,
    });
    expect(bindQueue).toHaveBeenCalledWith(DLQ, DLX, '#');
  });

  it('reuses the same channel across calls', async () => {
    const first = await getChannel();
    const second = await getChannel();

    expect(second).toBe(first);
  });

  it('refuses to connect without RABBITMQ_URL', async () => {
    await closeConnection();
    delete process.env.RABBITMQ_URL;

    expect(getChannel()).rejects.toThrow('RABBITMQ_URL is required');
  });
});

describe('closeConnection', () => {
  it('closes the channel and the connection', async () => {
    await getChannel();
    await closeConnection();

    expect(closeChannel).toHaveBeenCalled();
    expect(closeConnectionMock).toHaveBeenCalled();
  });
});
