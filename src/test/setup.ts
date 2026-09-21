import { mock } from 'bun:test';

process.env.OTEL_SERVICE_NAME ??= 'bunzina-billing';

mock.module('@lucas-pmelo/logger', () => ({
  default: {
    setEvent: () => {},
    setRequestId: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));
