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
  book: ReaderBook;
  manifest: ReadingManifest;
  html: string;
  assetBaseUrl: string;
}

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`读取书籍失败（${response.status}）`);
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

export async function getReaderDocument(bookId: string): Promise<ReaderDocument> {
  const root = `${apiBaseUrl}/v1/books/${encodeURIComponent(bookId)}`;
  const [bookResponse, manifestResponse, contentResponse] = await Promise.all([
    fetch(root),
    fetch(`${root}/manifest`),
    fetch(`${root}/content`),
  ]);

  const [bookRaw, manifest] = await Promise.all([
    readJson<Record<string, unknown>>(bookResponse),
    readJson<ReadingManifest>(manifestResponse),
  ]);
  if (!contentResponse.ok) {
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
    book: normalizeBook(bookRaw, bookId),
    manifest,
    html,
    assetBaseUrl: `${root}/assets/`,
  };
}
