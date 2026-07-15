import type {
  SharedBookStatus,
  UserBookWorkflowStatus,
} from '@readtailor/contracts';
import { apiBaseUrl } from '../../library/api';
import { ApiError } from '../apiError';

export type WorkflowStatus = UserBookWorkflowStatus;

export interface UserBookSharedBook {
  id: string;
  status: SharedBookStatus;
  title: string;
  authors: string[];
  coverPath: string | null;
  errorSummary: string | null;
}

export interface ReadingProgressSummary {
  percent: number;
  lastReadAt: string | null;
  estimatedRemainingSeconds: number | null;
}

export interface UserBookSummary {
  id: string;
  workflowStatus: UserBookWorkflowStatus;
  updatedAt: string;
  sharedBook: UserBookSharedBook;
  readingProgress: ReadingProgressSummary | null;
}

export interface UserBookDetail extends UserBookSummary {
  currentStrategyDraftVersionId: string | null;
  currentStrategyVersionId: string | null;
  currentTrialRevisionId: string | null;
}

export interface UserBookListResponse {
  userBooks: UserBookSummary[];
}

interface RawShelfItem {
  id: string;
  sharedBookId: string;
  sharedBookStatus: SharedBookStatus;
  workflowStatus: UserBookWorkflowStatus;
  title: string;
  authors: string[];
  coverPath: string | null;
  errorSummary: string | null;
  progress: number | null;
  lastActivityAt: string;
}

interface RawUserBookDetail {
  book: RawShelfItem;
  currentStrategyDraftVersionId?: string | null;
  currentStrategyVersionId?: string | null;
  currentTrialRevisionId?: string | null;
}

export async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('readtailor:unauthorized'));
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    throw new ApiError(
      typeof body?.error === 'string' ? body.error : `请求失败（${response.status}）`,
      response.status,
    );
  }
  return response.json() as Promise<T>;
}

export function userBookRoot(userBookId: string): string {
  return `${apiBaseUrl}/v1/user-books/${encodeURIComponent(userBookId)}`;
}

export async function getJson<T>(path: string): Promise<T> {
  return readJson<T>(await fetch(path, { credentials: 'include' }));
}

export async function postJson<T>(
  path: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  return readJson<T>(await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

function mapShelfItem(item: RawShelfItem): UserBookSummary {
  return {
    id: item.id,
    workflowStatus: item.workflowStatus,
    updatedAt: item.lastActivityAt,
    sharedBook: {
      id: item.sharedBookId,
      status: item.sharedBookStatus,
      title: item.title,
      authors: item.authors,
      coverPath: item.coverPath,
      errorSummary: item.errorSummary,
    },
    readingProgress: item.progress === null ? null : {
      percent: item.progress * 100,
      lastReadAt: item.lastActivityAt,
      // The backend does not expose a remaining-time estimate yet.
      estimatedRemainingSeconds: null,
    },
  };
}

export async function getUserBooks(): Promise<UserBookListResponse> {
  const raw = await getJson<{ books: RawShelfItem[] }>(`${apiBaseUrl}/v1/user-books`);
  return { userBooks: raw.books.map(mapShelfItem) };
}

export async function getUserBook(userBookId: string): Promise<UserBookDetail> {
  const raw = await getJson<RawUserBookDetail>(userBookRoot(userBookId));
  return {
    ...mapShelfItem(raw.book),
    currentStrategyDraftVersionId: raw.currentStrategyDraftVersionId ?? null,
    currentStrategyVersionId: raw.currentStrategyVersionId ?? null,
    currentTrialRevisionId: raw.currentTrialRevisionId ?? null,
  };
}
