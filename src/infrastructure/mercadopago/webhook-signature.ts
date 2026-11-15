import { createHmac, timingSafeEqual } from 'node:crypto';

type Input = {
  secret: string;
  signatureHeader: string | null;
  requestId: string | null;
  dataId: string | null;
};

const parseSignature = (header: string): { ts?: string; v1?: string } =>
  Object.fromEntries(
    header.split(',').map((part) => {
      const [key, ...value] = part.trim().split('=');
      return [key, value.join('=')];
    }),
  );

export const isValidWebhookSignature = ({
  secret,
  signatureHeader,
  requestId,
  dataId,
}: Input): boolean => {
  if (!signatureHeader || !requestId || !dataId) {
    return false;
  }
  const { ts, v1 } = parseSignature(signatureHeader);
  if (!ts || !v1) {
    return false;
  }
  const expected = createHmac('sha256', secret)
    .update(`id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`)
    .digest();
  const received = Buffer.from(v1, 'hex');

  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
};
