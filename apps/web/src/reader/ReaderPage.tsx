import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ProgressBar } from '../components/chrome/ProgressBar';
import { Segmented } from '../components/core/Segmented';
import { Slider } from '../components/core/Slider';
import { AssistanceContent, BriefCard } from '../user-books/components';
import {
  defaultReadingSettings,
  getReaderBootstrap,
  getReaderDocument,
  markReadNode,
  putReadingSettings,
  reportReaderFocus,
  saveReaderPositionBeacon,
} from './api';
import type {
  ContentWidthSetting,
  ReaderNodeEnhancement,
  ReaderOutlineItem,
  ReaderPosition,
  ReadingSettings,
  ThemeSetting,
} from './api';
import {
  domBoundaryForOffset,
  getFragmentTargetId,
  getOutlineDepth,
  offsetWithinBlock,
  prepareBookContent,
  readingBlocks,
} from './content';
import type { RenderedHeading, RenderedNode } from './content';
import { NotePopover, popoverPlacement } from './NotePopover';
import type { ActivePopover } from './NotePopover';

type ReaderSettings = ReadingSettings;

const defaultSettings: ReaderSettings = defaultReadingSettings;

// The reading-settings localStorage cache key (§11.6): server is authoritative; this only avoids
// a first-paint flash on next open.
const SETTINGS_CACHE_KEY = 'readtailor:reading-settings';

// The viewport-relative line the reader "reads from": position save probes for the character at
// this offset below the scroll top, and restore scrolls that character back to it. Save and restore
// MUST share this constant, or the anchor lands a fixed distance off on every reopen (§11.5).
const READING_ANCHOR_TOP = 96;

function readCachedSettings(): ReaderSettings | null {
  try {
    const raw = window.localStorage.getItem(SETTINGS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ReaderSettings>;
    if (typeof parsed.fontSize !== 'number' || typeof parsed.lineHeight !== 'number') return null;
    return { ...defaultSettings, ...parsed };
  } catch {
    return null;
  }
}

// Fold a DOM point (from the caret APIs) back to a block-relative UTF-16 offset. Returns
// { offsetNode, offset } across the standard (Firefox) and WebKit variants.
function caretAtPoint(x: number, y: number): { node: Node; offset: number } | null {
  const doc = window.document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = doc.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = doc.caretRangeFromPoint?.(x, y);
  if (range) return { node: range.startContainer, offset: range.startOffset };
  return null;
}

const themeOptions: ReadonlyArray<{ value: ThemeSetting; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'paper', label: '浅色' },
  { value: 'night', label: '深色' },
];

function resolvedTheme(theme: ThemeSetting, prefersDark: boolean): 'paper' | 'night' {
  return theme === 'system' ? (prefersDark ? 'night' : 'paper') : theme;
}

function usePrefersDark() {
  const [prefersDark, setPrefersDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setPrefersDark(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return prefersDark;
}

const contentWidthOptions: ReadonlyArray<{ value: ContentWidthSetting; label: string }> = [
  { value: 'narrow', label: '窄' },
  { value: 'medium', label: '中' },
  { value: 'wide', label: '宽' },
];

const contentWidths: Record<ContentWidthSetting, number> = {
  narrow: 600,
  medium: 680,
  wide: 760,
};

export function ReaderPage() {
  const { id = '' } = useParams();
  const query = useQuery({
    queryKey: ['reader-document', id],
    queryFn: () => getReaderDocument(id),
    enabled: Boolean(id),
  });

  if (query.isPending) {
    return <ReaderStatus title="正在展开书页" detail="正文与目录正在从书籍包中读取。" />;
  }
  if (query.isError) {
    return <ReaderStatus title="这本书暂时打不开" detail={query.error.message} retry={() => void query.refetch()} />;
  }

  return <LiveReader document={query.data} />;
}

function LiveReader({ document }: { document: Awaited<ReturnType<typeof getReaderDocument>> }) {
  const bootstrap = useQuery({
    queryKey: ['reader-bootstrap', document.userBookId],
    queryFn: () => getReaderBootstrap(document.userBookId),
    initialData: document.bootstrap,
    refetchInterval: (current) => current.state.data?.enhancements.some((item) => (
      item.status === 'queued' || item.status === 'generating'
    )) ? 3000 : false,
  });
  return <Reader document={{ ...document, bootstrap: bootstrap.data }} />;
}

function Reader({ document }: { document: Awaited<ReturnType<typeof getReaderDocument>> }) {
  // §11.6: server (bootstrap) is authoritative; the localStorage cache is only a pre-bootstrap
  // fallback. Presentation only — never feeds block enumeration / offset / progress.
  const [settings, setSettings] = useState<ReaderSettings>(
    () => document.bootstrap.settings ?? readCachedSettings() ?? defaultSettings,
  );
  const [tocOpen, setTocOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bookInfoOpen, setBookInfoOpen] = useState(false);
  const [currentOrder, setCurrentOrder] = useState(document.manifest.nodes[0]?.order ?? 1);
  const [popover, setPopover] = useState<ActivePopover | null>(null);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [chromeHidden, setChromeHidden] = useState(false);
  const scrollRoot = useRef<HTMLDivElement>(null);
  const lastScrollTop = useRef(0);
  // Layout-anchor state (§6.2): `committedEnhancementVersion` tracks which enhancement content is
  // currently in the DOM, and `pendingAnchor` carries the pre-commit position snapshot into the
  // post-commit layout effect. See the render-phase snapshot below.
  const committedEnhancementVersion = useRef<string | null>(null);
  const pendingAnchor = useRef<{ order: number; top: number } | null>(null);
  const prefersDark = usePrefersDark();
  const theme = resolvedTheme(settings.theme, prefersDark);
  const queryClient = useQueryClient();
  // Report the reading position so the host keeps the lazy-loading window generating (§6.2 /
  // PRD §11.3) and, via the optional anchor, persists the last reading position (§11.5). The host
  // grows the window only on order change and always saves the anchor, so intra-node scroll refines
  // the saved position without re-touching the window. The returned bootstrap surfaces newly queued
  // enhancements; the layout-anchor effect below keeps the scroll position stable.
  const focus = useMutation({
    mutationFn: (payload: { order: number; position?: ReaderPosition }) =>
      reportReaderFocus(document.userBookId, payload.order, payload.position),
    onSuccess: (bootstrap) => queryClient.setQueryData(['reader-bootstrap', document.userBookId], bootstrap),
  });
  const currentOrderRef = useRef(currentOrder);
  currentOrderRef.current = currentOrder;
  const reportFocus = useRef<(order: number, position?: ReaderPosition) => void>(() => {});
  reportFocus.current = (order, position) => {
    if (!Number.isFinite(order)) return;
    focus.mutate(position ? { order, position } : { order });
  };
  // Fold the reading-anchor line (READING_ANCHOR_TOP below the scroll top) into a
  // { blockIndex, offset } anchor (§11.5). Locate the node/block/offset DIRECTLY from the character
  // under the probe point — not from `currentOrder`, whose IntersectionObserver threshold is a
  // different reference line and drifts against a fixed pixel offset as the viewport height changes.
  // This makes save self-consistent with restore, which scrolls the same character back to the same
  // line. Falls back to the current node's top when the probe misses the text column (heading/gap).
  // Held in a ref so scroll/unload handlers always see live DOM, never a stale closure.
  const computeAnchorRef = useRef<() => ReaderPosition | null>(() => null);
  computeAnchorRef.current = () => {
    const root = scrollRoot.current;
    if (!root) return null;
    const rootRect = root.getBoundingClientRect();
    const probeY = rootRect.top + READING_ANCHOR_TOP;
    const probeX = rootRect.left + rootRect.width / 2;
    const currentNode = document.manifest.nodes.find((item) => item.order === currentOrderRef.current);
    const fallback = currentNode
      ? { sectionId: currentNode.section_id, segment: currentNode.segment, blockIndex: 1, offset: 0 }
      : null;
    const caret = caretAtPoint(probeX, probeY);
    if (!caret) return fallback;
    const anchorElement = caret.node instanceof Element ? caret.node : caret.node.parentElement;
    const nodeEl = anchorElement?.closest<HTMLElement>('[data-node-order]');
    const contentRoot = nodeEl?.querySelector<HTMLElement>('.reader-original');
    const sectionId = nodeEl?.dataset.sectionId;
    const segment = Number(nodeEl?.dataset.segment ?? Number.NaN);
    if (!nodeEl || !contentRoot || !sectionId || !Number.isFinite(segment) || !contentRoot.contains(caret.node)) {
      return fallback;
    }
    const blocks = readingBlocks(contentRoot);
    const block = blocks.find((candidate) => candidate.contains(caret.node));
    if (!block) return { sectionId, segment, blockIndex: 1, offset: 0 };
    return {
      sectionId,
      segment,
      blockIndex: blocks.indexOf(block) + 1,
      offset: offsetWithinBlock(block, caret.node, caret.offset),
    };
  };
  const positionTimer = useRef<number | null>(null);
  const schedulePositionReport = () => {
    if (positionTimer.current !== null) window.clearTimeout(positionTimer.current);
    positionTimer.current = window.setTimeout(() => {
      positionTimer.current = null;
      reportFocus.current(currentOrderRef.current, computeAnchorRef.current() ?? undefined);
    }, 800);
  };
  const enhancements = useMemo(() => new Map(
    document.bootstrap.enhancements.map((item) => [`${item.sectionId}:${item.segment}`, item]),
  ), [document.bootstrap.enhancements]);
  const annotationsByNode = useMemo(() => new Map(
    [...enhancements.entries()].map(([key, enhancement]) => [
      key,
      enhancement.status === 'ready' ? enhancement.tailoredContent?.annotations ?? [] : [],
    ]),
  ), [enhancements]);
  // Flat id → content lookup so a click on an in-text 裁读注 anchor can open its note
  // inline as a popover instead of scrolling to a list at the node's end.
  const annotationContentById = useMemo(() => {
    const map = new Map<string, string>();
    for (const list of annotationsByNode.values()) {
      for (const annotation of list) map.set(annotation.id, annotation.content);
    }
    return map;
  }, [annotationsByNode]);
  const prepared = useMemo(
    () => prepareBookContent(
      document.html,
      document.manifest.nodes,
      document.manifest.outline,
      document.assetBaseUrl,
      annotationsByNode,
    ),
    [annotationsByNode, document.assetBaseUrl, document.html, document.manifest],
  );
  const enhancementVersion = document.bootstrap.enhancements
    .map((item) => `${item.sectionId}:${item.segment}:${item.status}:${item.tailoredContent ? 'content' : 'empty'}`)
    .join('|');

  // getSnapshotBeforeUpdate-equivalent: when the enhancement content is about to change the DOM,
  // snapshot the current node's viewport top from the *old* DOM during render — before React commits
  // the newly inserted annotation blocks. Reading here (pre-commit) is what keeps the anchor from
  // going stale as the reader scrolls freely within a node between 3s bootstrap polls; the previous
  // implementation reused a top recorded at the last effect run and undid the reader's own scrolling.
  if (enhancementVersion !== committedEnhancementVersion.current && pendingAnchor.current === null) {
    const root = scrollRoot.current;
    const node = root?.querySelector<HTMLElement>(`[data-node-order="${currentOrder}"]`);
    if (root && node) {
      pendingAnchor.current = { order: currentOrder, top: node.getBoundingClientRect().top };
    }
  }

  useLayoutEffect(() => {
    committedEnhancementVersion.current = enhancementVersion;
    const snapshot = pendingAnchor.current;
    pendingAnchor.current = null;
    if (!snapshot) return;
    const root = scrollRoot.current;
    const node = root?.querySelector<HTMLElement>(`[data-node-order="${snapshot.order}"]`);
    if (!root || !node) return;
    // Content inserted above the anchor shifted it by (top - snapshot.top); undo that shift so the
    // paragraph the reader is on stays visually put across the re-render.
    root.scrollTop += node.getBoundingClientRect().top - snapshot.top;
  }, [enhancementVersion]);

  // §11.5 position restore: on first content commit, scroll to the saved anchor (block + offset).
  // Runs once (restoredRef). Fallback chain per PRD §11.5: exact block → the node's first block →
  // (node missing) start of book. Deliberately runs before the layout-anchor takes over, then hands
  // stability to it as enhancements stream in. On first mount the layout-anchor is a no-op (the
  // scroll ref is null during that render), so there is no scroll fight.
  const restoredRef = useRef(false);
  useLayoutEffect(() => {
    if (restoredRef.current) return;
    const root = scrollRoot.current;
    if (!root) return;
    restoredRef.current = true;
    const pos = document.bootstrap.resumePosition;
    if (!pos) return;
    const node = document.manifest.nodes.find((item) => item.section_id === pos.sectionId && item.segment === pos.segment);
    if (!node) return;
    const nodeEl = root.querySelector<HTMLElement>(`[data-node-order="${node.order}"]`);
    const contentRoot = nodeEl?.querySelector<HTMLElement>('.reader-original');
    if (!nodeEl || !contentRoot) return;
    const blocks = readingBlocks(contentRoot);
    const exact = blocks[pos.blockIndex - 1];
    const block = exact ?? blocks[0];
    const rootTop = root.getBoundingClientRect().top;
    const headroom = READING_ANCHOR_TOP;
    let targetTop = (block ?? nodeEl).getBoundingClientRect().top;
    if (exact) {
      const boundary = domBoundaryForOffset(exact, pos.offset);
      if (boundary) {
        try {
          const range = window.document.createRange();
          range.setStart(boundary.container, boundary.offset);
          range.collapse(true);
          const rect = range.getBoundingClientRect();
          if (rect.top || rect.bottom) targetTop = rect.top || rect.bottom;
        } catch {
          // fall through to the block/node top already in targetTop
        }
      }
    }
    root.scrollTop += targetTop - rootTop - headroom;
    setCurrentOrder(node.order);
    currentOrderRef.current = node.order;
  }, [prepared]);

  useEffect(() => {
    const root = scrollRoot.current;
    if (!root) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => Math.abs(left.boundingClientRect.top) - Math.abs(right.boundingClientRect.top));
      const order = Number((visible[0]?.target as HTMLElement | undefined)?.dataset.nodeOrder);
      if (Number.isFinite(order)) setCurrentOrder(order);
    }, { root, rootMargin: '-12% 0px -72% 0px', threshold: 0 });
    root.querySelectorAll<HTMLElement>('[data-node-order]').forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [prepared]);

  // Warm the window for the opening/resumed node even if the reader never scrolls; scroll-driven
  // reports (schedulePositionReport) and jumps take over from here.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      reportFocus.current(currentOrderRef.current, computeAnchorRef.current() ?? undefined);
    }, 300);
    return () => window.clearTimeout(handle);
  }, []);

  // §11.5: save position immediately when the tab is hidden or the page is being unloaded — the
  // debounced scroll report may not have fired yet. keepalive lets the request outlive unload.
  useEffect(() => {
    const flush = () => {
      const anchor = computeAnchorRef.current();
      if (anchor) saveReaderPositionBeacon(document.userBookId, currentOrderRef.current, anchor);
    };
    const onVisibility = () => {
      if (window.document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
    };
  }, [document.userBookId]);

  // §11.6: mirror settings to the localStorage cache immediately and debounce the cross-device PUT.
  // Skip the first run so opening the reader does not re-PUT unchanged settings.
  const settingsInitRef = useRef(true);
  useEffect(() => {
    try {
      window.localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(settings));
    } catch {
      // a full/blocked localStorage must not break reading
    }
    if (settingsInitRef.current) {
      settingsInitRef.current = false;
      return;
    }
    const handle = window.setTimeout(() => {
      void putReadingSettings(settings).catch(() => {});
    }, 600);
    return () => window.clearTimeout(handle);
  }, [settings]);

  // §11.4: mark a node read once any part enters the viewport while the page is visible. Monotonic
  // and idempotent — a local set (seeded from bootstrap) prevents duplicate POSTs; a failed POST is
  // rolled back locally so it retries on the next intersection.
  const markedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const item of document.bootstrap.readNodes) markedRef.current.add(`${item.sectionId}:${item.segment}`);
  }, [document.bootstrap.readNodes]);
  useEffect(() => {
    const root = scrollRoot.current;
    if (!root) return;
    const observer = new IntersectionObserver((entries) => {
      if (window.document.visibilityState !== 'visible') return;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const element = entry.target as HTMLElement;
        const sectionId = element.dataset.sectionId;
        const segment = Number(element.dataset.segment);
        if (!sectionId || !Number.isFinite(segment)) continue;
        const key = `${sectionId}:${segment}`;
        if (markedRef.current.has(key)) continue;
        markedRef.current.add(key);
        void markReadNode(document.userBookId, { sectionId, segment }).catch(() => {
          markedRef.current.delete(key);
        });
      }
    }, { root, threshold: 0 });
    root.querySelectorAll<HTMLElement>('[data-node-order]').forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [prepared, document.userBookId]);

  useEffect(() => {
    const closeOverlays = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setTocOpen(false);
      setSettingsOpen(false);
      setBookInfoOpen(false);
      setPopover(null);
    };
    window.addEventListener('keydown', closeOverlays);
    return () => window.removeEventListener('keydown', closeOverlays);
  }, []);

  useEffect(() => {
    const closePopover = () => setPopover(null);
    window.addEventListener('resize', closePopover);
    return () => window.removeEventListener('resize', closePopover);
  }, []);

  const handleScroll = () => {
    const root = scrollRoot.current;
    if (!root) return;
    const max = root.scrollHeight - root.clientHeight;
    setScrollProgress(max > 0 ? (root.scrollTop / max) * 100 : 0);
    const delta = root.scrollTop - lastScrollTop.current;
    if (delta > 4 && root.scrollTop > 180 && !tocOpen && !settingsOpen && !bookInfoOpen && !popover) {
      setChromeHidden(true);
    } else if ((delta < -4 || root.scrollTop < 120) && chromeHidden) {
      setChromeHidden(false);
    }
    lastScrollTop.current = root.scrollTop;
    setPopover(null);
    // Debounced position report (§11.5): saves intra-node scroll position and grows the window
    // when the settled node changes.
    schedulePositionReport();
  };

  const jumpToOrder = (order: number) => {
    scrollRoot.current?.querySelector<HTMLElement>(`[data-node-order="${order}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTocOpen(false);
    // Explicit jump: report the target now (with the top-of-node anchor) so its window is
    // prioritized and the saved position matches the jump before the scroll settles.
    const target = document.manifest.nodes.find((item) => item.order === order);
    reportFocus.current(order, target
      ? { sectionId: target.section_id, segment: target.segment, blockIndex: 1, offset: 0 }
      : undefined);
  };

  const handleContentClick = (event: React.MouseEvent<HTMLElement>) => {
    setChromeHidden(false);
    const tailoredAnchor = (event.target as HTMLElement).closest<HTMLElement>('[data-annotation-id]');
    if (tailoredAnchor?.dataset.annotationId) {
      const content = annotationContentById.get(tailoredAnchor.dataset.annotationId);
      if (!content) return;
      setPopover({ body: { kind: 'tailored', content }, ...popoverPlacement(tailoredAnchor.getBoundingClientRect()) });
      return;
    }
    const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
    if (!anchor) return;
    const targetId = getFragmentTargetId(anchor.getAttribute('href'));
    const isNoteref = anchor.dataset.role === 'noteref';
    const originalNote = targetId ? prepared.notes.get(targetId) : undefined;
    if (isNoteref) {
      event.preventDefault();
      if (anchor.dataset.broken === 'true' || !originalNote) return;
      setPopover({ body: { kind: 'note', html: originalNote.html }, ...popoverPlacement(anchor.getBoundingClientRect()) });
      return;
    }
    if (!targetId) return;
    const targetOutline = document.manifest.outline.find((item) => item.section_id === targetId);
    if (targetOutline) {
      event.preventDefault();
      jumpToOrder(targetOutline.first_node_order);
    }
  };

  const totalCharacters = document.manifest.book_total_characters
    ?? document.manifest.position_index?.book_total_characters
    ?? document.manifest.nodes.reduce((sum, node) => sum + node.character_count, 0);
  const charactersBefore = document.manifest.nodes
    .filter((node) => node.order < currentOrder)
    .reduce((sum, node) => sum + node.character_count, 0);
  const textProgress = totalCharacters > 0 ? Math.round((charactersBefore / totalCharacters) * 100) : 0;
  const activeSectionId = [...document.manifest.outline]
    .filter((item) => item.first_node_order <= currentOrder)
    .at(-1)?.section_id;
  const openToc = () => {
    setSettingsOpen(false);
    setBookInfoOpen(false);
    setChromeHidden(false);
    setTocOpen(true);
  };
  const openSettings = () => {
    setTocOpen(false);
    setBookInfoOpen(false);
    setChromeHidden(false);
    setSettingsOpen(true);
  };
  const openBookInfo = () => {
    setTocOpen(false);
    setSettingsOpen(false);
    setChromeHidden(false);
    setBookInfoOpen(true);
  };

  return (
    <div
      className="reader-shell"
      lang={document.book.language}
      data-reader-language={document.book.language}
      data-rt-theme={theme === 'night' ? 'night' : undefined}
    >
      <ProgressBar value={scrollProgress} aria-label="阅读滚动进度" />
      <div className="reader-chrome" data-hidden={chromeHidden}>
        <header className="reader-toolbar">
          <Link className="reader-back-button" to="/" aria-label="返回书架" title="返回书架">‹</Link>
          <div className="reader-title" title={document.book.title}>{document.book.title}</div>
          <div className="reader-desktop-actions">
            <ReaderAction glyph="≡" label="目录" onClick={openToc} />
            <ReaderAction glyph="···" label="本书" onClick={openBookInfo} />
            <ReaderAction glyph="Aa" label="设置" onClick={openSettings} />
          </div>
        </header>
      </div>

      <nav className="reader-mobile-bar" data-hidden={chromeHidden} aria-label="阅读工具">
        <ReaderAction glyph="≡" label="目录" onClick={openToc} />
        <ReaderAction glyph="···" label="本书" onClick={openBookInfo} />
        <ReaderAction glyph="Aa" label="设置" onClick={openSettings} />
      </nav>

      {settingsOpen && <button className="reader-modal-scrim" type="button" onClick={() => setSettingsOpen(false)} aria-label="关闭阅读设置" />}
      {bookInfoOpen && <button className="reader-modal-scrim" type="button" onClick={() => setBookInfoOpen(false)} aria-label="关闭本书说明" />}
      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          update={(patch) => setSettings((current) => ({ ...current, ...patch }))}
          close={() => setSettingsOpen(false)}
        />
      )}
      {bookInfoOpen && (
        <BookInfoPanel
          title={document.book.title}
          briefing={document.bootstrap.briefing}
          strategySummary={document.bootstrap.strategySummary}
          close={() => setBookInfoOpen(false)}
        />
      )}

      <div ref={scrollRoot} className="reader-scroll" onScroll={handleScroll}>
        <main
          className="reader-page"
          style={{
            '--reader-font-size': `${settings.fontSize}px`,
            '--reader-line-height': settings.lineHeight,
            '--reader-content-width': `${contentWidths[settings.contentWidth]}px`,
          } as React.CSSProperties}
          onClick={handleContentClick}
        >
          <header className="reader-book-heading">
            <div className="reader-chapter-kicker">
              <span>原文阅读 · Original text</span>
              <i aria-hidden="true" />
              <span>全书 {textProgress}%</span>
            </div>
            <h1>{document.book.title}</h1>
            <p><span aria-hidden="true">◷</span>{document.book.authors.join(' · ') || '作者未详'}</p>
          </header>
          {prepared.nodes.map((node) => (
            <ReadingNode
              key={`${node.section_id}:${node.segment}`}
              node={node}
              bookTitle={document.book.title}
              enhancement={enhancements.get(`${node.section_id}:${node.segment}`)}
            />
          ))}
          <footer className="reader-end"><span>⌜</span> 本书原文到此结束 <span>⌟</span></footer>
        </main>
      </div>

      <TocDrawer
        open={tocOpen}
        title={document.book.title}
        outline={document.manifest.outline}
        activeSectionId={activeSectionId}
        close={() => setTocOpen(false)}
        jump={jumpToOrder}
      />
      <NotePopover popover={popover} close={() => setPopover(null)} />
      <div className="reader-bottom-fade" aria-hidden="true" />
    </div>
  );
}

function ReaderAction({ glyph, label, onClick }: { glyph: string; label: string; onClick: () => void }) {
  return (
    <button className="reader-action" type="button" onClick={onClick} aria-label={label} title={label}>
      <span aria-hidden="true">{glyph}</span>
      <span>{label}</span>
    </button>
  );
}

function ReadingNode({ node, bookTitle, enhancement }: {
  node: RenderedNode;
  bookTitle: string;
  enhancement: ReaderNodeEnhancement | undefined;
}) {
  const headings = node.headings.filter((heading) => heading.title.trim() !== bookTitle.trim());
  const content = enhancement?.status === 'ready' ? enhancement.tailoredContent : null;
  return (
    <section
      className="reader-node"
      data-has-heading={headings.length > 0}
      data-node-order={node.order}
      data-section-id={node.section_id}
      data-segment={node.segment}
      id={`reader-node-${node.order}`}
    >
      {headings.map((heading) => (
        <OutlineHeading key={heading.section_id} heading={heading} />
      ))}
      {content?.guide ? (
        <section className="tailored-guide reader-tailored-block">
          <span>GUIDE · 导读</span>
          <AssistanceContent content={content.guide} />
        </section>
      ) : null}
      {enhancement && ['queued', 'generating'].includes(enhancement.status) ? (
        <div className="reader-enhancement-state">✦ 裁读内容正在准备，原文可以先读。</div>
      ) : null}
      {enhancement?.status === 'failed' ? (
        <div className="reader-enhancement-state" data-failed="true">裁读内容暂时没有生成，原文不受影响。</div>
      ) : null}
      <div className="reader-original rt-reader-content" dangerouslySetInnerHTML={{ __html: node.html }} />
      {content?.afterReading ? (
        <section className="tailored-after-reading reader-tailored-block">
          <span>AFTER READING · 节后助读</span>
          <AssistanceContent content={content.afterReading} />
        </section>
      ) : null}
    </section>
  );
}

function OutlineHeading({ heading }: { heading: RenderedHeading }) {
  const props = {
    className: 'reader-outline-heading rt-reader-heading-content',
    'data-outline-type': heading.data_type,
    'data-outline-level': heading.visualLevel,
  };
  if (heading.visualLevel === 'part') {
    return <div {...props}><span dangerouslySetInnerHTML={{ __html: heading.html }} /></div>;
  }
  if (heading.visualLevel === 'section') {
    return <h3 {...props} dangerouslySetInnerHTML={{ __html: heading.html }} />;
  }
  if (heading.visualLevel === 'subsection') {
    return <h4 {...props} dangerouslySetInnerHTML={{ __html: heading.html }} />;
  }
  if (heading.visualLevel === 'deep') {
    return <h5 {...props} dangerouslySetInnerHTML={{ __html: heading.html }} />;
  }
  return <h2 {...props} dangerouslySetInnerHTML={{ __html: heading.html }} />;
}

function TocDrawer({ open, title, outline, activeSectionId, close, jump }: {
  open: boolean;
  title: string;
  outline: ReaderOutlineItem[];
  activeSectionId: string | undefined;
  close: () => void;
  jump: (order: number) => void;
}) {
  return (
    <>
      <button className="reader-scrim" data-open={open} onClick={close} aria-label="关闭目录" tabIndex={open ? 0 : -1} />
      <aside className="toc-drawer" data-open={open} aria-hidden={!open} aria-label="本书目录">
        <div className="reader-sheet-handle" aria-hidden="true" />
        <header>
          <div><span>目录 · Contents</span><strong>{title}</strong></div>
          <button className="reader-icon-button" type="button" onClick={close} aria-label="关闭目录">×</button>
        </header>
        <p className="toc-description">进度只算原文位置，原书注释不计入。</p>
        <nav>
          {outline.map((item) => {
            const active = item.section_id === activeSectionId;
            return (
              <button
                key={item.section_id}
                type="button"
                className="toc-item"
                data-active={active}
                style={{ '--toc-depth': getOutlineDepth(item, outline) } as React.CSSProperties}
                onClick={() => jump(item.first_node_order)}
              >
                <span>{item.title || '未命名部分'}</span>
                {active && <i aria-label="当前位置">·</i>}
              </button>
            );
          })}
        </nav>
      </aside>
    </>
  );
}

function SettingsPanel({ settings, update, close }: {
  settings: ReaderSettings;
  update: (patch: Partial<ReaderSettings>) => void;
  close: () => void;
}) {
  return (
    <aside className="reader-settings" aria-label="阅读设置">
      <div className="reader-sheet-handle" aria-hidden="true" />
      <header><strong>阅读设置 · Aa</strong><button type="button" onClick={close} aria-label="关闭阅读设置">×</button></header>
      <div className="reader-setting-row">
        <span>字号</span>
        <Slider label="字号" min={16} max={24} value={settings.fontSize} onChange={(fontSize) => update({ fontSize })} showValue format={(value) => `${value}px`} />
      </div>
      <div className="reader-setting-row reader-setting-wide">
        <span>行距</span>
        <Slider label="行距" min={1.55} max={2.35} step={0.1} value={settings.lineHeight} onChange={(lineHeight) => update({ lineHeight })} showValue format={(value) => value.toFixed(2)} />
      </div>
      <div className="reader-setting-row reader-setting-wide">
        <span>版心</span>
        <Segmented
          label="正文宽度"
          value={settings.contentWidth}
          onChange={(contentWidth) => update({ contentWidth })}
          options={contentWidthOptions}
        />
      </div>
      <fieldset className="reader-setting-row">
        <legend>主题</legend>
        <Segmented
          label="阅读主题"
          value={settings.theme}
          onChange={(theme) => update({ theme })}
          options={themeOptions}
        />
      </fieldset>
    </aside>
  );
}

function BookInfoPanel({ title, briefing, strategySummary, close }: {
  title: string;
  briefing: string;
  strategySummary: string;
  close: () => void;
}) {
  const hasBriefing = briefing.trim().length > 0;
  const hasStrategy = strategySummary.trim().length > 0;
  return (
    <aside className="reader-book-info" aria-label="本书说明">
      <div className="reader-sheet-handle" aria-hidden="true" />
      <header><strong>本书说明 · {title}</strong><button type="button" onClick={close} aria-label="关闭本书说明">×</button></header>
      {hasBriefing ? <BriefCard briefing={briefing} /> : null}
      {hasStrategy ? (
        <section className="reader-current-strategy">
          <span>当前处理方式</span>
          <AssistanceContent content={strategySummary} />
        </section>
      ) : null}
      {!hasBriefing && !hasStrategy ? <p className="reader-book-info-empty">当前没有可展示的读前简报或处理方式。</p> : null}
    </aside>
  );
}

function ReaderStatus({ title, detail, retry }: { title: string; detail: string; retry?: () => void }) {
  return (
    <main className="reader-status">
      <Link to="/">‹ 返回书架</Link>
      <div aria-hidden="true">⌜　⌟</div>
      <h1>{title}</h1>
      <p>{detail}</p>
      {retry && <button type="button" onClick={retry}>重新读取</button>}
    </main>
  );
}
