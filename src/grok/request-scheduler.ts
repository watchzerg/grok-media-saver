export type SchedulerOptions = {
  minSeconds: number;
  maxSeconds: number;
  now?: () => number;
  random?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

export function createRequestScheduler(options: SchedulerOptions) {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? sleepWithSignal;
  let previousRequestAt: number | undefined;
  let nextDelayMilliseconds = 0;

  return {
    async beforeRequest(signal: AbortSignal): Promise<void> {
      if (previousRequestAt === undefined) return;
      const remaining = previousRequestAt + nextDelayMilliseconds - now();
      if (remaining > 0) await sleep(remaining, signal);
      if (signal.aborted) throw new Error("请求已停止");
    },
    requestStarted(): void {
      previousRequestAt = now();
      const fraction = Math.min(1, Math.max(0, random()));
      nextDelayMilliseconds =
        (options.minSeconds +
          fraction * (options.maxSeconds - options.minSeconds)) *
        1000;
    },
  };
}

function sleepWithSignal(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("等待已停止"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new Error("等待已停止"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
