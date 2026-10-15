// Polls an endpoint forever: `fn` every `ms` milliseconds, after the previous call settled. Errors are
// swallowed (the frame stream reports connectivity).
export function poll(fn: () => Promise<unknown>, ms: number): void {
  const tick = async () => {
    try { await fn(); } catch { /* reported elsewhere */ }
    setTimeout(() => void tick(), ms);
  };
  void tick();
}
