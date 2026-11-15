// All connection hints share one probe sequence. Browser network events and
// failed library requests are hints, not proof that the server is unavailable.
export function createServerConnectionCheck(probe: () => Promise<boolean>, update: (online: boolean) => void) {
  let failures = 0;
  let pending: Promise<void> | undefined;
  let stopped = false;
  return {
    check(): Promise<void> {
      if (stopped) return Promise.resolve();
      if (pending) return pending;
      pending = (async () => {
        let online = false;
        try { online = await probe(); } catch { /* Count a failed probe below. */ }
        if (stopped) return;
        failures = online ? 0 : failures + 1;
        if (online || failures >= 3) update(online);
      })().finally(() => { pending = undefined; });
      return pending;
    },
    stop() { stopped = true; },
  };
}
