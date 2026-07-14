function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError('JSON data must not contain non-finite numbers');
  }
  return JSON.stringify(value);
}

export function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return serializeNumber(value);
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value !== 'object') {
    throw new TypeError(`JSON data contains unsupported ${typeof value} value`);
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}
