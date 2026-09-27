import { afterEach, expect, it, vi } from "vitest";
import { pollAfterSettled } from "./poll.js";

afterEach(() => vi.useRealTimers());

it("waits for slow responses and stops scheduling after cleanup", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const load = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const stop = pollAfterSettled(load, 900);
  await vi.advanceTimersByTimeAsync(5000);
  expect(load).toHaveBeenCalledTimes(1);
  finish();
  await vi.advanceTimersByTimeAsync(899);
  expect(load).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(load).toHaveBeenCalledTimes(2);
  stop();
  finish();
  await vi.advanceTimersByTimeAsync(5000);
  expect(load).toHaveBeenCalledTimes(2);
});

it("continues after a handled request failure", async () => {
  vi.useFakeTimers();
  const fail = vi.fn();
  const read = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
  const stop = pollAfterSettled(() => read().catch(fail), 900);
  await vi.advanceTimersByTimeAsync(1800);
  expect(fail).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledTimes(2);
  stop();
});
