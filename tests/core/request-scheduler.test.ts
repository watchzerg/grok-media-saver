import { expect, test } from "bun:test";
import { createRequestScheduler } from "../../src/grok/request-scheduler";

test("request scheduler sends the first request immediately and waits one sampled interval after it", async () => {
  let now = 0;
  const waits: number[] = [];
  const scheduler = createRequestScheduler({
    minSeconds: 5,
    maxSeconds: 8,
    now: () => now,
    random: () => 0.5,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    },
  });
  const signal = new AbortController().signal;

  await scheduler.beforeRequest(signal);
  expect(waits).toEqual([]);
  scheduler.requestStarted();
  await scheduler.beforeRequest(signal);
  expect(waits).toEqual([6500]);
});

test("request scheduler skips the wait when the previous request already used the interval", async () => {
  let now = 0;
  const waits: number[] = [];
  const scheduler = createRequestScheduler({
    minSeconds: 5,
    maxSeconds: 8,
    now: () => now,
    random: () => 0,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    },
  });
  const signal = new AbortController().signal;
  await scheduler.beforeRequest(signal);
  scheduler.requestStarted();
  now += 6000;
  await scheduler.beforeRequest(signal);
  expect(waits).toEqual([]);
});
