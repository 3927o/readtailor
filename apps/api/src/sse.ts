/** Provides transport-level helpers shared by API server-sent event streams. */

// Interleaves keep-alive comments without replacing the pending source read, so no event is lost.
export async function* withHeartbeat(
  source: AsyncGenerator<string>,
  intervalMs: number,
): AsyncGenerator<string> {
  let pending = source.next();
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const heartbeat = new Promise<'heartbeat'>((resolve) => {
      timer = setTimeout(() => resolve('heartbeat'), intervalMs);
    });
    const winner = await Promise.race([pending.then(() => 'data' as const), heartbeat]);
    if (timer) clearTimeout(timer);
    if (winner === 'heartbeat') {
      yield ': ping\n\n';
      continue;
    }
    const result = await pending;
    if (result.done) return;
    yield result.value;
    pending = source.next();
  }
}
