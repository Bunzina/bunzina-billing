import amqp, { type Channel, type ChannelModel } from 'amqplib';

export const EXCHANGE = process.env.RABBITMQ_EXCHANGE || 'bunzina.events';
export const QUEUE = process.env.RABBITMQ_QUEUE || 'bunzina-billing.inbox';
export const DLX = `${EXCHANGE}.dlx`;
export const DLQ = `${QUEUE}.dlq`;

let connection: ChannelModel | null = null;
let channel: Channel | null = null;

export const getChannel = async (): Promise<Channel> => {
  if (channel) {
    return channel;
  }

  const url = process.env.RABBITMQ_URL;

  if (!url) {
    throw new Error('RABBITMQ_URL is required');
  }

  connection = await amqp.connect(url);
  channel = await connection.createChannel();

  await assertTopology(channel);

  await channel.prefetch(10);

  return channel;
};

const assertTopology = async (ch: Channel): Promise<void> => {
  await ch.assertExchange(EXCHANGE, 'topic', { durable: true });
  await ch.assertExchange(DLX, 'topic', { durable: true });

  await ch.assertQueue(DLQ, { durable: true });
  await ch.bindQueue(DLQ, DLX, '#');

  await ch.assertQueue(QUEUE, {
    durable: true,
    deadLetterExchange: DLX,
  });
};

export const closeConnection = async (): Promise<void> => {
  await channel?.close();
  await connection?.close();

  channel = null;
  connection = null;
};
