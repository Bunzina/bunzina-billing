import { describe, expect, it } from 'bun:test';
import { startPeriodicJob } from './periodic-job';

const until = async (condition: () => boolean) => {
  for (let i = 0; i < 200 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('startPeriodicJob', () => {
  it('runs the job again and again, and keeps going after a failed run', async () => {
    let runs = 0;
    const job = startPeriodicJob({
      name: 'test',
      intervalMs: 1,
      run: async () => {
        runs += 1;
        if (runs === 1) {
          throw new Error('boom');
        }
      },
    });

    await until(() => runs >= 3);
    await job.stop();

    expect(runs).toBeGreaterThanOrEqual(3);
  });

  it('waits for the run in progress and runs no more once stopped', async () => {
    let finished = false;
    let started = false;
    const job = startPeriodicJob({
      name: 'test',
      intervalMs: 1,
      run: async () => {
        started = true;
        await new Promise((resolve) => setTimeout(resolve, 20));
        finished = true;
      },
    });

    await until(() => started);
    await job.stop();
    const runsAtStop = finished;
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(runsAtStop).toBe(true);
  });
});
