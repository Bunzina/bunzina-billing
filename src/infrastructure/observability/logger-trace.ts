import logger from '@lucas-pmelo/logger';
import { trace } from '@opentelemetry/api';

const INVALID_TRACE_ID = '00000000000000000000000000000000';

type SetEvent = typeof logger.setEvent;

const originalSetEvent: SetEvent = logger.setEvent.bind(logger);

logger.setEvent = function setEventWithTraceId(
  ...args: Parameters<SetEvent>
): ReturnType<SetEvent> {
  originalSetEvent(...args);

  const traceId = trace.getActiveSpan()?.spanContext().traceId;

  if (traceId && traceId !== INVALID_TRACE_ID) {
    logger.setRequestId(traceId);
  }
} as SetEvent;
