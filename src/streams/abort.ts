export interface TimedAbort {
  controller: AbortController;
  clear(): void;
  timedOut(): boolean;
}

export function createTimedAbort(
  timeoutMs: number,
  parentSignal?: AbortSignal,
): TimedAbort {
  const controller = new AbortController();
  let timeout = false;
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort(new DOMException("Operation timed out.", "TimeoutError"));
  }, timeoutMs);

  const onParentAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  let cleared = false;
  return {
    controller,
    clear() {
      if (cleared) return;
      cleared = true;
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
    timedOut: () => timeout,
  };
}

