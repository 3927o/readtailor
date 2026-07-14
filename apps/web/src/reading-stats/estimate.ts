const DEFAULT_READING_SPEED_CHARS_PER_SEC: Record<string, number> = { zh: 6.5, en: 18 };
const FALLBACK_READING_SPEED_CHARS_PER_SEC = 9;

export function readingSecondsPerCharacter(
  remainingSeconds: number | null | undefined,
  remainingCharacters: number | null | undefined,
  language: string,
): number {
  if (typeof remainingSeconds === 'number' && remainingSeconds > 0
    && typeof remainingCharacters === 'number' && remainingCharacters > 0) {
    return remainingSeconds / remainingCharacters;
  }
  const primary = language.toLowerCase().split('-')[0]!;
  const charsPerSecond = DEFAULT_READING_SPEED_CHARS_PER_SEC[primary] ?? FALLBACK_READING_SPEED_CHARS_PER_SEC;
  return 1 / charsPerSecond;
}

export function estimateReadingSeconds(characterCount: number, secondsPerCharacter: number): number {
  return Math.max(0, Math.round(characterCount * secondsPerCharacter));
}
