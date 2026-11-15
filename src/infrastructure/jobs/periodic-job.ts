import logger from '@lucas-pmelo/logger';

type Input = {
  name: string;
  intervalMs: number;
  run: () => Promise<unknown>;
};

export const startPeriodicJob = ({ name, intervalMs, run }: Input) => {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  const tick = async () => {
    try {
      await run();
    } catch (error) {
      logger.error({
        message: `${name} run failed`,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (!stopped) {
        timer = setTimeout(() => {
          inFlight = tick();
        }, intervalMs);
      }
    }
  };

  inFlight = tick();

  return {
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await inFlight;
    },
  };
};
