/** Renders the shared inline cursor used while an Agent-owned text field is still growing. */

export function StreamingCursor({ active }: { active: boolean }) {
  return active
    ? <span className="rss-stream-cursor" aria-hidden="true" />
    : null;
}
