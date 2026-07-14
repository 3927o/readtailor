import type { TailoredContent, WorkflowStatus } from '../user-books/api';

export interface ReaderBook {
  id: string;
  title: string;
  authors: string[];
  language: string;
  coverPath: string | null;
}

export interface ReaderOutlineItem {
  section_id: string;
  data_type: string;
  title: string;
  parent_section_id: string | null;
  first_node_order: number;
}

export interface ReaderNode {
  section_id: string;
  segment: number;
  order: number;
  region: string;
  data_type: string;
  title: string;
  parent_section_id: string | null;
  character_count: number;
  block_count: number;
  node_absolute_start?: number;
}

export interface ReadingManifest {
  version: string;
  document: {
    title: string;
    language: string;
  };
  outline: ReaderOutlineItem[];
  nodes: ReaderNode[];
  book_total_characters?: number;
  position_index?: {
    book_total_characters?: number;
  };
}

export interface ReaderDocument {
  userBookId: string;
  bootstrap: ReaderBootstrap;
  book: ReaderBook;
  manifest: ReadingManifest;
  html: string;
  assetBaseUrl: string;
}

export type NodeEnhancementStatus = 'not_applicable' | 'queued' | 'generating' | 'ready' | 'failed';

export interface ReaderNodeEnhancement {
  sectionId: string;
  segment: number;
  status: NodeEnhancementStatus;
  tailoredContent: TailoredContent | null;
  errorSummary: string | null;
}

export interface ReaderBootstrap {
  userBookId: string;
  sharedBookId: string;
  workflowStatus: WorkflowStatus;
  enhancements: ReaderNodeEnhancement[];
  // Raw backend strings — rendered directly, no fabricated briefing structure (§5).
  briefing: string;
  strategySummary: string;
}

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('readtailor:unauthorized'));
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    throw new Error(typeof body?.error === 'string' ? body.error : `读取书籍失败（${response.status}）`);
  }
  return response.json() as Promise<T>;
}

function normalizeBook(raw: Record<string, unknown>, bookId: string): ReaderBook {
  const authors = raw.authors ?? raw.author;
  return {
    id: String(raw.id ?? bookId),
    title: String(raw.title ?? '未命名书籍'),
    authors: Array.isArray(authors)
      ? authors.map(String)
      : typeof authors === 'string' && authors
        ? [authors]
        : [],
    language: String(raw.language ?? 'und'),
    coverPath: typeof raw.coverPath === 'string'
      ? raw.coverPath
      : typeof raw.cover_path === 'string'
        ? raw.cover_path
        : null,
  };
}

export async function getReaderDocument(userBookId: string): Promise<ReaderDocument> {
  const bootstrap = await getReaderBootstrap(userBookId);
  if (bootstrap.workflowStatus !== 'active_reading') {
    throw new Error('这本书还没有完成试读确认。');
  }
  const bookId = bootstrap.sharedBookId;
  const root = `${apiBaseUrl}/v1/books/${encodeURIComponent(bookId)}`;
  const [bookResponse, manifestResponse, contentResponse] = await Promise.all([
    fetch(root, { credentials: 'include' }),
    fetch(`${root}/manifest`, { credentials: 'include' }),
    fetch(`${root}/content`, { credentials: 'include' }),
  ]);

  const [bookRaw, manifest] = await Promise.all([
    readJson<Record<string, unknown>>(bookResponse),
    readJson<ReadingManifest>(manifestResponse),
  ]);
  if (!contentResponse.ok) {
    if (contentResponse.status === 401) window.dispatchEvent(new Event('readtailor:unauthorized'));
    throw new Error(`读取书籍正文失败（${contentResponse.status}）`);
  }
  const contentType = contentResponse.headers.get('content-type') ?? '';
  const html = contentType.includes('application/json')
    ? String((await contentResponse.json() as { html?: unknown }).html ?? '')
    : await contentResponse.text();
  if (!html) {
    throw new Error('书籍正文为空');
  }

  return {
    userBookId,
    bootstrap,
    book: normalizeBook(bookRaw, bookId),
    manifest,
    html,
    assetBaseUrl: `${root}/assets/`,
  };
}

interface RawReaderBootstrap {
  userBookId: string;
  sharedBookId: string;
  workflowStatus: 'active_reading';
  briefing: string;
  strategySummary: string;
  enhancements: Array<{
    sectionId: string;
    segment: number;
    status: 'queued' | 'generating' | 'ready' | 'failed' | 'retrying' | 'superseded';
    result: TailoredContent | null;
  }>;
}

function mapReaderBootstrap(raw: RawReaderBootstrap): ReaderBootstrap {
  return {
    userBookId: raw.userBookId,
    sharedBookId: raw.sharedBookId,
    workflowStatus: raw.workflowStatus,
    briefing: raw.briefing,
    strategySummary: raw.strategySummary,
    enhancements: raw.enhancements.map((enhancement) => ({
      sectionId: enhancement.sectionId,
      segment: enhancement.segment,
      status: enhancement.status === 'retrying'
        ? 'generating'
        : enhancement.status === 'superseded'
          ? 'not_applicable'
          : enhancement.status,
      tailoredContent: enhancement.result,
      errorSummary: enhancement.status === 'failed' ? '裁读内容生成失败' : null,
    })),
  };
}

export async function getReaderBootstrap(userBookId: string): Promise<ReaderBootstrap> {
  return mapReaderBootstrap(await readJson<RawReaderBootstrap>(await fetch(
    `${apiBaseUrl}/v1/user-books/${encodeURIComponent(userBookId)}/reader`,
    { credentials: 'include' },
  )));
}

// Reports the reader's current (or jumped-to) node so the host grows the lazy-loading window
// and raises the target's generation priority (§6.2 / PRD §11.3). Returns the fresh bootstrap
// so newly-queued enhancements surface immediately.
export async function reportReaderFocus(userBookId: string, order: number): Promise<ReaderBootstrap> {
  return mapReaderBootstrap(await readJson<RawReaderBootstrap>(await fetch(
    `${apiBaseUrl}/v1/user-books/${encodeURIComponent(userBookId)}/reader/focus`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ order }),
    },
  )));
}
