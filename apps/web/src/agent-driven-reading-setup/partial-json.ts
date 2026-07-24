/** Recovers the largest valid value from an append-only JSON stream. */

function closeJsonPrefix(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    // Continue with a best-effort closure for progressive card rendering.
  }
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const character of source) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === '{') stack.push('}');
    else if (character === '[') stack.push(']');
    else if (character === '}' || character === ']') stack.pop();
  }
  let completed = source;
  // A trailing backslash starts an escape whose value has not arrived yet. Dropping only
  // that character keeps the already streamed string visible until the next delta lands.
  if (inString && escaped) completed = completed.slice(0, -1);
  if (inString) completed += '"';
  completed = completed.replace(/,?\s*$/, '');
  for (let index = stack.length - 1; index >= 0; index -= 1) completed += stack[index];
  try {
    return JSON.parse(completed);
  } catch {
    return undefined;
  }
}

function recoveryPoints(source: string): number[] {
  const points: number[] = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === ',') {
      // Drop a property or array item whose value has only partially arrived.
      points.push(index);
    } else if (character === '{' || character === '[') {
      // Preserve the containing structure when its first member is incomplete.
      points.push(index + 1);
    }
  }
  return points;
}

export function parsePartialJson(source: string): unknown {
  if (!source.trim()) return undefined;
  const completed = closeJsonPrefix(source);
  if (completed !== undefined) return completed;

  // An incomplete next key (`{"prompt":"…","opt`) must not erase fields that were
  // already complete. Walk structural boundaries backwards until the largest stable
  // prefix can be closed and parsed.
  const points = recoveryPoints(source);
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const recovered = closeJsonPrefix(source.slice(0, points[index]));
    if (recovered !== undefined) return recovered;
  }
  return undefined;
}
