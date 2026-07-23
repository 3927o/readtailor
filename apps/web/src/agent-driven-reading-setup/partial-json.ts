export function parsePartialJson(source: string): unknown {
  if (!source.trim()) return undefined;
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
  if (inString) completed += '"';
  completed = completed.replace(/,?\s*$/, '');
  for (let index = stack.length - 1; index >= 0; index -= 1) completed += stack[index];
  try {
    return JSON.parse(completed);
  } catch {
    return undefined;
  }
}
