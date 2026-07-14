import type {
  BookNormalizationStatus,
  HealthResponse,
  ImportBookResponse,
} from '@readtailor/contracts';

export const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('readtailor:unauthorized'));
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    throw new Error(typeof body?.error === 'string' ? body.error : `请求失败（${response.status}）`);
  }
  return response.json() as Promise<T>;
}

export async function getHealth(): Promise<HealthResponse> {
  return readJson<HealthResponse>(await fetch(`${apiBaseUrl}/v1/health`));
}

export async function getBookNormalizationStatus(bookId: string): Promise<BookNormalizationStatus> {
  return readJson<BookNormalizationStatus>(
    await fetch(`${apiBaseUrl}/v1/books/${encodeURIComponent(bookId)}/status`, {
      credentials: 'include',
    }),
  );
}

export async function importBook(file: File): Promise<ImportBookResponse> {
  const form = new FormData();
  form.append('file', file);
  return readJson<ImportBookResponse>(
    await fetch(`${apiBaseUrl}/v1/books/import`, {
      method: 'POST',
      credentials: 'include',
      body: form,
    }),
  );
}

export async function retryBookNormalization(bookId: string): Promise<ImportBookResponse> {
  return readJson<ImportBookResponse>(
    await fetch(`${apiBaseUrl}/v1/books/${encodeURIComponent(bookId)}/retry`, {
      method: 'POST',
      credentials: 'include',
    }),
  );
}

export function bookCoverUrl(bookId: string, coverPath: string | null): string | undefined {
  if (!coverPath) return undefined;
  const assetPath = coverPath.replace(/^assets\//, '');
  return `${apiBaseUrl}/v1/books/${encodeURIComponent(bookId)}/assets/${assetPath
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}

export function bookAssetBaseUrl(bookId: string): string {
  return `${apiBaseUrl}/v1/books/${encodeURIComponent(bookId)}/assets/`;
}
