import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import type { Briefing } from '@readtailor/contracts';
import { ProgressBar } from '../components/chrome/ProgressBar';
import { Segmented } from '../components/core/Segmented';
import { Slider } from '../components/core/Slider';
import { AssistanceContent, BriefCard } from '../user-books/components';
import {
  createHighlight,
  defaultReadingSettings,
  deleteHighlight,
  getBookReadingStats,
  getGlobalReadingStats,
  getReaderBootstrap,
  getReaderDocument,
  markReadNode,
  putReadingSettings,
  reportReaderFocus,
  saveReaderPositionBeacon,
  sendActivitySlice,
  updateHighlightNote,
} from './api';
import type {
  ContentWidthSetting,
  Highlight,
  ObservedReaderAnchor,
  ReaderBootstrap,
  ReaderNode,
  ReaderNodeEnhancement,
  ReaderOutlineItem,
  ReaderPosition,
  ReadingSettings,
  ReadingStatsGlobal,
  ReadingStatsPerBook,
  ThemeSetting,
} from './api';
import { localDay, localWeekStart, ReadingSessionTracker, type ReadingActivityArea, type ReadingActivityPosition } from './session';
import {
  domBoundaryForOffset,
  getFragmentTargetId,
  getOutlineDepth,
  nearestReaderAnchor,
  prepareBookContent,
  rangeFromSelection,
  readingBlocks,
} from './content';
import type { AnchorProbe } from './content';
import type { RenderedHeading, RenderedNode } from './content';
import { createRestoreCoordinator } from './restoreCoordinator';
import { NotePopover, popoverPlacement } from './NotePopover';
import type { ActivePopover } from './NotePopover';

type ReaderSettings = ReadingSettings;

type NodeRange = Highlight['range'];
type PopoverPlacement = Omit<ActivePopover, 'body'>;

// A finished text selection inside one reading node, ready to become a highlight (§11.7). The range
// is already folded to block/offset; `placement` positions the floating action toolbar.
interface SelectionDraft {
  sectionId: string;
  segment: number;
  range: NodeRange;
  placement: PopoverPlacement;
}

// The highlight note editor: composing a note for a brand-new highlight, or viewing/editing an
// existing one (with delete-note / delete-highlight affordances). §11.7.
type HighlightEditorState =
  | { mode: 'create'; sectionId: string; segment: number; range: NodeRange; placement: PopoverPlacement }
  | { mode: 'edit'; highlight: Highlight; placement: PopoverPlacement };

const defaultSettings: ReaderSettings = defaultReadingSettings;

// The reading-settings localStorage cache key (§11.6): server is authoritative; this only avoids
// a first-paint flash on next open.
const SETTINGS_CACHE_KEY = 'readtailor:reading-settings';

// §11.8 session cadence (implementation params, not surfaced): the accountant ticks every second; a
// heartbeat flushes to the server every 15s (plus on node change / hide / unload). JUMP_SETTLE_MS is
// the window after a TOC jump during which order changes are treated as a jump, not forward reading.
const TICK_MS = 1000;
const HEARTBEAT_MS = 15_000;
const JUMP_SETTLE_MS = 1200;

// §11.9 — reading-length format ("适合阅读的分钟/小时格式"). Sub-minute rounds up to 1 分钟 so a just-
// started session never shows 0.
function formatReadingDuration(totalSeconds: number): string {
  const minutes = Math.max(0, Math.round(totalSeconds / 60));
  if (minutes < 1) return totalSeconds > 0 ? '1 分钟' : '0 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`;
}

// §11.10 — the remaining-time label. Approximate estimates (language-default speed) read「约 …」; a
// personal-speed estimate drops the 约. Null (unknown book length) shows a dash.
function formatRemaining(remaining: ReadingStatsPerBook['remaining'] | undefined): string {
  if (!remaining || remaining.seconds === null) return '—';
  const body = formatReadingDuration(remaining.seconds);
  return remaining.approximate ? `约 ${body}` : body;
}

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

// The reading-node content root containing a DOM node, or null if the node sits outside原文 (heading,
// tailored block, gap). Used to confine a highlight selection to one node (§11.7 不跨节点).
function contentRootOf(node: Node): HTMLElement | null {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest<HTMLElement>('.reader-original') ?? null;
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

// Live-DOM implementation of the anchor probe nearestReaderAnchor resolves against. Kept out of the
// resolver so the geometry is injectable in tests. A boundary/block with no measurable rect reports
// null so the resolver declines rather than fabricate a position (§3.1).
function domAnchorProbe(): AnchorProbe {
  return {
    caretAtPoint,
    boundaryTop(boundary) {
      try {
        const range = window.document.createRange();
        range.setStart(boundary.container, boundary.offset);
        range.collapse(true);
        const rect = range.getBoundingClientRect();
        if (rect.top === 0 && rect.bottom === 0 && rect.height === 0 && rect.width === 0) return null;
        return rect.top || rect.bottom;
      } catch {
        return null;
      }
    },
    blockBox(block) {
      const rect = block.getBoundingClientRect();
      if (rect.height === 0 && rect.top === 0 && rect.bottom === 0) return null;
      return { top: rect.top, bottom: rect.bottom };
    },
  };
}

const themeOptions: ReadonlyArray<{ value: ThemeSetting; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'paper', label: '浅色' },
  { value: 'night', label: '深色' },
];

function resolvedTheme(theme: ThemeSetting, prefersDark: boolean): 'paper' | 'night' {
  return theme === 'system' ? (prefersDark ? 'night' : 'paper') : theme;
}

// §3.3 fallback step 3: when the saved section/segment no longer resolves to a node, pick the
// manifest node whose order is closest to the saved nodeOrder (ties → the earlier node).
function nearestNodeByOrder(nodes: ReaderNode[], targetOrder: number): ReaderNode | undefined {
  let best: ReaderNode | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    const distance = Math.abs(node.order - targetOrder);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = node;
    }
  }
  return best;
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
  const [statsOpen, setStatsOpen] = useState(false);
  const [currentOrder, setCurrentOrder] = useState(document.manifest.nodes[0]?.order ?? 1);
  const [popover, setPopover] = useState<ActivePopover | null>(null);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [chromeHidden, setChromeHidden] = useState(false);
  // §11.7 highlights: seeded once from bootstrap and mutated locally on CRUD, so a focus-report
  // response (which overwrites the bootstrap cache) can't drop a just-created highlight. Presentation
  // for the mark pass + the list view; never feeds block/offset/progress.
  const [highlights, setHighlights] = useState<Highlight[]>(() => document.bootstrap.highlights);
  const [selectionDraft, setSelectionDraft] = useState<SelectionDraft | null>(null);
  const [highlightEditor, setHighlightEditor] = useState<HighlightEditorState | null>(null);
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
    // §4.3 anti-regression: two focus responses can resolve out of order. Take the fresh bootstrap
    // (for newly-queued enhancements) but never let an older `resumePosition` overwrite a newer one
    // already in cache — compare by clientObservedAt (ISO order == chronological).
    onSuccess: (bootstrap) => queryClient.setQueryData<ReaderBootstrap>(
      ['reader-bootstrap', document.userBookId],
      (previous) => {
        const previousResume = previous?.resumePosition;
        if (previousResume && (!bootstrap.resumePosition
          || previousResume.clientObservedAt > bootstrap.resumePosition.clientObservedAt)) {
          return { ...bootstrap, resumePosition: previousResume };
        }
        return bootstrap;
      },
    ),
  });
  const currentOrderRef = useRef(currentOrder);
  currentOrderRef.current = currentOrder;
  // Scroll-ownership phase (§2.4). While `restoring`, the restore coordinator is the ONLY writer of
  // scrollTop and warm/scroll position saves are suppressed; on `settled`/`cancelled`/`normal` the
  // layout-anchor and the save链路 resume. Fresh opens (no resume anchor) stay `normal` throughout.
  const restorePhaseRef = useRef<'restoring' | 'settled' | 'cancelled' | 'normal'>('normal');
  const reportFocus = useRef<(order: number, position?: ReaderPosition) => void>(() => {});
  reportFocus.current = (order, position) => {
    if (!Number.isFinite(order)) return;
    focus.mutate(position ? { order, position } : { order });
  };
  // Fold the reading-anchor line (READING_ANCHOR_TOP below the scroll top) into an
  // { order, position } observation (§11.5, fix §2.1/§2.2). The node/block/offset are located
  // DIRECTLY from the character under the probe point via nearestReaderAnchor, and `order`,
  // `sectionId`, `segment` all come from that SAME [data-node-order] element — never spliced with
  // `currentOrder`, whose IntersectionObserver threshold is a different reference line. On a probe
  // miss the resolver falls to the nearest original-text character; if nothing reliable is under the
  // anchor line it returns null and we save NO precise position (the old "current node block 1"
  // fallback is gone — it destroyed a good saved position on headings/gaps/media). Held in a ref so
  // scroll/unload handlers always see live DOM, never a stale closure.
  const computeAnchorRef = useRef<() => ObservedReaderAnchor | null>(() => null);
  computeAnchorRef.current = () => {
    const root = scrollRoot.current;
    if (!root) return null;
    const rootRect = root.getBoundingClientRect();
    const probeY = rootRect.top + READING_ANCHOR_TOP;
    const probeX = rootRect.left + rootRect.width / 2;
    const roots = [...root.querySelectorAll<HTMLElement>('.reader-original')];
    const anchor = nearestReaderAnchor(roots, probeX, probeY, domAnchorProbe());
    if (!anchor) return null;
    const nodeEl = anchor.root.closest<HTMLElement>('[data-node-order]');
    const order = Number(nodeEl?.dataset.nodeOrder ?? Number.NaN);
    const sectionId = nodeEl?.dataset.sectionId;
    const segment = Number(nodeEl?.dataset.segment ?? Number.NaN);
    if (!nodeEl || !sectionId || !Number.isFinite(order) || !Number.isFinite(segment)) return null;
    return {
      order,
      position: {
        sectionId,
        segment,
        blockIndex: anchor.blockIndex,
        offset: anchor.offset,
        clientObservedAt: new Date().toISOString(),
      },
    };
  };
  // Send the current observation: with a precise anchor, persist { order, position }; without one,
  // report the settled order alone so the generation window stays warm but no coarse position is
  // written (§3.2). Suppressed while the restore coordinator owns the scroll (§2.4) — see restorePhaseRef.
  const reportObservation = useRef<() => void>(() => {});
  reportObservation.current = () => {
    if (restorePhaseRef.current === 'restoring') return;
    const observed = computeAnchorRef.current();
    reportFocus.current(observed?.order ?? currentOrderRef.current, observed?.position);
  };
  const positionTimer = useRef<number | null>(null);
  const schedulePositionReport = () => {
    if (positionTimer.current !== null) window.clearTimeout(positionTimer.current);
    positionTimer.current = window.setTimeout(() => {
      positionTimer.current = null;
      reportObservation.current();
    }, 800);
  };

  // §11.8/§11.10 effective-reading session. One tracker instance for the reader's lifetime; the
  // lifecycle effect below drives its 1s tick and activity-slice flushes. Order changes (from the
  // IntersectionObserver and jumps) feed forward-progress; scroll/pointer/key feed activity. All sends
  // are fire-and-forget — session tracking must never block or crash reading.
  const sessionRef = useRef<ReadingSessionTracker | null>(null);
  if (sessionRef.current === null) sessionRef.current = new ReadingSessionTracker();
  const charCountByOrder = useMemo(
    () => new Map(document.manifest.nodes.map((node) => [node.order, node.character_count])),
    [document.manifest.nodes],
  );
  const nodeByOrder = useMemo(
    () => new Map(document.manifest.nodes.map((node) => [node.order, node])),
    [document.manifest.nodes],
  );
  const fallbackActivityPosition = (order: number): ReadingActivityPosition => {
    const node = nodeByOrder.get(order) ?? document.manifest.nodes[0];
    return {
      order: node?.order ?? order,
      sectionId: node?.section_id ?? 'unknown',
      segment: node?.segment ?? 1,
      blockIndex: 1,
      offset: 0,
    };
  };
  const toActivityPosition = (observed: ObservedReaderAnchor | null): ReadingActivityPosition => {
    if (!observed) return fallbackActivityPosition(currentOrderRef.current);
    return {
      order: observed.order,
      sectionId: observed.position.sectionId,
      segment: observed.position.segment,
      blockIndex: observed.position.blockIndex,
      offset: observed.position.offset,
    };
  };
  const resolveActivityArea = (): ReadingActivityArea => {
    if (tocOpen || settingsOpen || statsOpen || bookInfoOpen) return 'reader_chrome';
    if (popover) return 'assistance';
    const root = scrollRoot.current;
    if (!root) return 'reader_chrome';
    const rect = root.getBoundingClientRect();
    const target = window.document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + READING_ANCHOR_TOP,
    ) as HTMLElement | null;
    if (target?.closest('.reader-tailored-block')) return 'assistance';
    if (target?.closest('.reader-original')) return 'original';
    return 'reader_chrome';
  };
  // Set on a TOC jump: order changes within JUMP_SETTLE_MS after it are treated as a jump (no forward
  // credit for skipped content, §11.10 目录大跳不算读完中间).
  const jumpEndRef = useRef(0);
  const flushActivitySlice = useRef<(keepalive?: boolean, tickFirst?: boolean, discontinuous?: boolean) => Promise<void>>(() => Promise.resolve());
  flushActivitySlice.current = (keepalive = false, tickFirst = false, discontinuous = false) => {
    const now = Date.now();
    if (tickFirst) sessionRef.current?.tick(now);
    const observed = computeAnchorRef.current();
    const payload = sessionRef.current?.activitySlice(
      now,
      toActivityPosition(observed),
      resolveActivityArea(),
      discontinuous,
    );
    if (payload) return sendActivitySlice(document.userBookId, payload, keepalive ? { keepalive: true } : {});
    return Promise.resolve();
  };
  const recordOrder = useRef<(order: number) => void>(() => {});
  recordOrder.current = (order) => {
    // A TOC jump OR the programmatic restore scroll (§2.4) is not forward reading: credit no skipped
    // chars, just move the frontier to the landing node so real reading onward counts from there.
    const viaJump = Date.now() < jumpEndRef.current || restorePhaseRef.current === 'restoring';
    sessionRef.current?.recordOrder(Date.now(), order, (o) => charCountByOrder.get(o) ?? 0, viaJump);
  };

  // §11.9/§11.10 stats. Per-book stats back the remaining-time indicator (near the progress bar) and
  // the stats panel; global stats (今日/本周/累计/连续天数) load when the panel opens. `day`/`weekStart`
  // are the client's local calendar boundaries so 今日/本周 honor its timezone.
  const bookStats = useQuery({
    queryKey: ['reading-stats-book', document.userBookId],
    queryFn: () => getBookReadingStats(document.userBookId),
    staleTime: 30_000,
  });
  const globalStats = useQuery({
    queryKey: ['reading-stats-global', document.userBookId],
    queryFn: () => getGlobalReadingStats(localDay(Date.now()), localWeekStart(Date.now())),
    enabled: statsOpen,
    staleTime: 15_000,
  });
  const refetchBookStats = bookStats.refetch;
  const refetchGlobalStats = globalStats.refetch;
  // Refresh per-book stats a beat after the settled node changes: the remaining-time estimate depends
  // on the stored position, which persists on an 800ms debounce, so wait past that before re-reading.
  useEffect(() => {
    const handle = window.setTimeout(() => void refetchBookStats(), 2500);
    return () => window.clearTimeout(handle);
  }, [currentOrder, refetchBookStats]);
  // Opening the stats panel pulls the freshest data (§11.9 「再次进入统计视图必须看到已提交的数据」).
  useEffect(() => {
    if (!statsOpen) return;
    void flushActivitySlice.current(false, true).finally(() => {
      void refetchGlobalStats();
      void refetchBookStats();
    });
  }, [statsOpen, refetchGlobalStats, refetchBookStats]);

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
  // §11.7 highlights grouped by node key for the mark pass, and a flat id lookup so a click on a
  // highlight mark opens its editor.
  const highlightsByNode = useMemo(() => {
    const map = new Map<string, Highlight[]>();
    for (const highlight of highlights) {
      const key = `${highlight.sectionId}:${highlight.segment}`;
      const list = map.get(key);
      if (list) list.push(highlight);
      else map.set(key, [highlight]);
    }
    return map;
  }, [highlights]);
  const highlightById = useMemo(() => new Map(highlights.map((item) => [item.id, item])), [highlights]);
  const prepared = useMemo(
    () => prepareBookContent(
      document.html,
      document.manifest.nodes,
      document.manifest.outline,
      document.assetBaseUrl,
      annotationsByNode,
      highlightsByNode,
    ),
    [annotationsByNode, highlightsByNode, document.assetBaseUrl, document.html, document.manifest],
  );
  // Layout-anchor key (§6.2): change when enhancement content OR the highlight marks change, so the
  // pre-commit snapshot below keeps the current paragraph visually put across either re-render. Note
  // text is included because it flips a mark's dataset; a `<mark>` reflows nothing, but keying on it
  // costs nothing and keeps the anchor honest if that ever changes.
  const enhancementVersion = [
    document.bootstrap.enhancements
      .map((item) => `${item.sectionId}:${item.segment}:${item.status}:${item.tailoredContent ? 'content' : 'empty'}`)
      .join('|'),
    highlights.map((item) => `${item.id}:${item.note ? 'n' : '_'}`).join(','),
  ].join('§');

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
    // §2.4 single scroll ownership: while the restore coordinator is pinning the boundary it is the
    // only scroll writer. The layout-anchor must not also compensate this same reflow, or the shift
    // is counted twice; the coordinator re-measures the boundary each frame and handles it instead.
    if (restorePhaseRef.current === 'restoring') return;
    if (!snapshot) return;
    const root = scrollRoot.current;
    const node = root?.querySelector<HTMLElement>(`[data-node-order="${snapshot.order}"]`);
    if (!root || !node) return;
    // Content inserted above the anchor shifted it by (top - snapshot.top); undo that shift so the
    // paragraph the reader is on stays visually put across the re-render.
    root.scrollTop += node.getBoundingClientRect().top - snapshot.top;
  }, [enhancementVersion]);

  // §11.5 / §2.4 position restore: on first mount, resolve the saved anchor and hand it to the
  // restore coordinator, which pins that character boundary to the reading line through first-paint
  // layout drift (fonts, late images, streamed enhancements) until it stabilizes or the user takes
  // over. Runs ONCE (restoredRef) with a `[]` dep so a streamed-in enhancement changing `prepared`
  // mid-restore can't tear the coordinator down. The coordinator is the sole scroll writer while
  // active; the layout-anchor above yields to it (restorePhaseRef).
  const restoredRef = useRef(false);
  useLayoutEffect(() => {
    if (restoredRef.current) return;
    const root = scrollRoot.current;
    if (!root) return;
    restoredRef.current = true;
    const resume = document.bootstrap.resumePosition;
    if (!resume) return; // fresh open: nothing to restore, phase stays 'normal'

    const nodes = document.manifest.nodes;
    // §3.3 fallback chain: exact section/segment → nearest by nodeOrder → start of book.
    const exactNode = nodes.find((item) => item.section_id === resume.sectionId && item.segment === resume.segment);
    const targetNode = exactNode ?? nearestNodeByOrder(nodes, resume.nodeOrder) ?? nodes[0];
    if (!targetNode) return;
    const nodeEl = root.querySelector<HTMLElement>(`[data-node-order="${targetNode.order}"]`);
    if (!nodeEl) return;
    const contentRoot = nodeEl.querySelector<HTMLElement>('.reader-original');

    // Only trust the stored block/offset when we landed on the EXACT node AND the anchor was computed
    // against the current block algorithm. A manifestVersion mismatch, or any fall back to a
    // different node, drops us to node/block granularity rather than reinterpreting a stale offset.
    const versionMatches = resume.manifestVersion == null || resume.manifestVersion === document.manifest.version;
    let boundary: { container: Node; offset: number } | null = null;
    let geometryEl: HTMLElement = nodeEl;
    if (exactNode && versionMatches && contentRoot) {
      const blocks = readingBlocks(contentRoot);
      const exactBlock = blocks[resume.blockIndex - 1];
      const block = exactBlock ?? blocks[0];
      if (block) {
        geometryEl = block;
        if (exactBlock) {
          const resolved = domBoundaryForOffset(exactBlock, resume.offset);
          if (resolved) boundary = resolved;
        }
      }
    } else if (!exactNode || !versionMatches) {
      // Observable: we deliberately declined to reinterpret a stale/relocated anchor (§3.3).
      // eslint-disable-next-line no-console
      console.info('[reader] resume fell back to node granularity', {
        reason: !exactNode ? 'node-missing' : 'manifest-version-changed',
        savedManifestVersion: resume.manifestVersion,
        currentManifestVersion: document.manifest.version,
      });
    }

    // The saved boundary's current top, relative to the scroll container top edge — the same frame
    // READING_ANCHOR_TOP is measured in. Falls back to the block/node top when no precise boundary.
    const measureTop = (): number | null => {
      const rootTop = root.getBoundingClientRect().top;
      if (boundary) {
        try {
          const range = window.document.createRange();
          range.setStart(boundary.container, boundary.offset);
          range.collapse(true);
          const rect = range.getBoundingClientRect();
          const top = rect.top || rect.bottom;
          if (top) return top - rootTop;
        } catch {
          // fall through to element geometry
        }
      }
      return geometryEl.getBoundingClientRect().top - rootTop;
    };

    setCurrentOrder(targetNode.order);
    currentOrderRef.current = targetNode.order;
    restorePhaseRef.current = 'restoring';

    // Instant restore: suppress `.reader-scroll`'s smooth behavior so corrections don't animate — a
    // mid-animation sample would land off the anchor line (§1.4).
    const previousScrollBehavior = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';

    let torndown = false;
    const cleanups: Array<() => void> = [];
    const teardown = () => {
      if (torndown) return;
      torndown = true;
      root.style.scrollBehavior = previousScrollBehavior;
      for (const cleanup of cleanups) cleanup();
    };

    const coordinator = createRestoreCoordinator({
      now: () => performance.now(),
      requestFrame: (callback) => window.requestAnimationFrame(callback),
      cancelFrame: (handle) => window.cancelAnimationFrame(handle),
      getScrollTop: () => root.scrollTop,
      setScrollTop: (value) => { root.scrollTop = value; },
      measureTop,
      anchorTop: READING_ANCHOR_TOP,
      onSettle: () => {
        // Phase flips before the report so reportObservation is no longer suppressed; one final
        // stable-anchor save (§2.4), then release control.
        restorePhaseRef.current = 'settled';
        reportObservation.current();
        teardown();
      },
    });
    // Stop the rAF loop on teardown (including an unmount mid-restore) so it never ticks on a
    // detached root. A no-op once the coordinator has already settled/cancelled.
    cleanups.push(() => coordinator.cancel());

    // Any deliberate user input hands control back immediately (§2.4); the user's own scroll then
    // flows through the normal save chain. Programmatic scrollTop writes don't emit these events.
    const cancelToUser = () => {
      if (coordinator.phase() !== 'restoring') return;
      coordinator.cancel();
      restorePhaseRef.current = 'cancelled';
      teardown();
    };
    const navKeys = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar']);
    const onKey = (event: KeyboardEvent) => { if (navKeys.has(event.key)) cancelToUser(); };
    for (const type of ['wheel', 'touchstart', 'pointerdown'] as const) {
      root.addEventListener(type, cancelToUser, { passive: true });
      cleanups.push(() => root.removeEventListener(type, cancelToUser));
    }
    window.addEventListener('keydown', onKey);
    cleanups.push(() => window.removeEventListener('keydown', onKey));

    // Early completion is gated on assets that move the boundary: fonts and images that sit BEFORE
    // the target. Below/at-target images don't shift it, so they don't hold up the handoff (§2.4).
    let fontsReady = false;
    let pendingImages = 0;
    const maybeReady = () => { if (fontsReady && pendingImages === 0) coordinator.markAssetsReady(); };
    const precedingImages = [...root.querySelectorAll<HTMLImageElement>('img')].filter((image) => (
      !image.complete
      && (geometryEl.compareDocumentPosition(image) & Node.DOCUMENT_POSITION_PRECEDING) !== 0
    ));
    pendingImages = precedingImages.length;
    for (const image of precedingImages) {
      const done = () => { pendingImages = Math.max(0, pendingImages - 1); maybeReady(); };
      image.addEventListener('load', done, { once: true });
      image.addEventListener('error', done, { once: true });
      cleanups.push(() => {
        image.removeEventListener('load', done);
        image.removeEventListener('error', done);
      });
    }
    const fonts = window.document.fonts;
    if (fonts?.ready) {
      fonts.ready.then(() => { fontsReady = true; maybeReady(); }).catch(() => {});
    } else {
      fontsReady = true;
    }
    maybeReady();

    coordinator.start();
    return teardown;
  }, []);

  useEffect(() => {
    const root = scrollRoot.current;
    if (!root) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => Math.abs(left.boundingClientRect.top) - Math.abs(right.boundingClientRect.top));
      const order = Number((visible[0]?.target as HTMLElement | undefined)?.dataset.nodeOrder);
      if (Number.isFinite(order)) {
        setCurrentOrder(order);
        // §11.10: feed the settled node into the session tracker so forward-read chars accrue (a jump
        // within JUMP_SETTLE_MS is credited as a jump, not forward reading).
        recordOrder.current(order);
        flushActivitySlice.current();
      }
    }, { root, rootMargin: '-12% 0px -72% 0px', threshold: 0 });
    root.querySelectorAll<HTMLElement>('[data-node-order]').forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [prepared]);

  // Warm the window for the opening/resumed node even if the reader never scrolls; scroll-driven
  // reports (schedulePositionReport) and jumps take over from here. Suppressed while the restore
  // coordinator still owns the scroll — reportObservation checks the phase (§2.4).
  useEffect(() => {
    const handle = window.setTimeout(() => {
      reportObservation.current();
    }, 300);
    return () => window.clearTimeout(handle);
  }, []);

  // §11.5: save position immediately when the tab is hidden or the page is being unloaded — the
  // debounced scroll report may not have fired yet. keepalive lets the request outlive unload.
  useEffect(() => {
    const flush = () => {
      // §3.2: on unload, only persist a precise anchor. If the probe can't sample one, send nothing —
      // never a destructive fallback that would replace a good saved position with a chapter start.
      const observed = computeAnchorRef.current();
      if (observed) saveReaderPositionBeacon(document.userBookId, observed.order, observed.position);
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

  // §11.8: drive the effective-reading session. A 1s accountant advances the tracker (which decides
  // active vs idle) and, on the active→idle edge, flushes + ends the interval so idle time is never
  // back-filled. A 15s activity-slice flush sends the running interval; node changes, backgrounding, and unload
  // flush + end immediately (immediate submit, §11.8). Being mounted IS being in the formal reader.
  useEffect(() => {
    const tracker = sessionRef.current;
    if (!tracker) return;
    tracker.setInReader(true);
    tracker.setVisible(window.document.visibilityState === 'visible');
    tracker.initOrder(currentOrderRef.current);
    tracker.initPosition(fallbackActivityPosition(currentOrderRef.current));

    // Scroll direction is handled in handleScroll; here we capture the other activity kinds. A moving
    // pointer / key / touch marks presence but not forward reading (that's forward scroll only).
    const onActivity = () => tracker.recordActivity(Date.now(), false);
    const activityEvents: Array<keyof WindowEventMap> = ['pointerdown', 'pointermove', 'keydown', 'touchstart'];
    activityEvents.forEach((type) => window.addEventListener(type, onActivity, { passive: true }));

    let wasActive = false;
    const tickTimer = window.setInterval(() => {
      const active = tracker.tick(Date.now());
      if (wasActive && !active) {
        flushActivitySlice.current();
        tracker.endInterval();
      }
      wasActive = active;
    }, TICK_MS);
    const beatTimer = window.setInterval(() => flushActivitySlice.current(), HEARTBEAT_MS);

    const onVisibility = () => {
      const visible = window.document.visibilityState === 'visible';
      tracker.setVisible(visible);
      if (!visible) {
        void flushActivitySlice.current(true, true);
        tracker.endInterval();
        wasActive = false;
      }
    };
    const onPageHide = () => {
      void flushActivitySlice.current(true, true);
      tracker.endInterval();
      wasActive = false;
    };
    window.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);

    return () => {
      activityEvents.forEach((type) => window.removeEventListener(type, onActivity));
      window.clearInterval(tickTimer);
      window.clearInterval(beatTimer);
      window.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      // Leaving the reader (unmount / route change) ends the interval and flushes it (keepalive so a
      // fast teardown still delivers).
      void flushActivitySlice.current(true, true);
      tracker.endInterval();
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
      setStatsOpen(false);
      setPopover(null);
      setSelectionDraft(null);
      setHighlightEditor(null);
    };
    window.addEventListener('keydown', closeOverlays);
    return () => window.removeEventListener('keydown', closeOverlays);
  }, []);

  useEffect(() => {
    const closePopover = () => setPopover(null);
    window.addEventListener('resize', closePopover);
    return () => window.removeEventListener('resize', closePopover);
  }, []);

  // §11.7 selection → highlight toolbar. When the reader finishes a text selection inside ONE reading
  // node, fold it to a block range (rangeFromSelection) and float the action toolbar over it. A
  // collapsed selection, or one that leaves the node (cross-node highlights aren't allowed), clears
  // the toolbar. Runs on mouseup / touchend (deferred a tick so the selection is finalized).
  useEffect(() => {
    const root = scrollRoot.current;
    if (!root) return;
    const evaluate = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        setSelectionDraft(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const startRoot = contentRootOf(range.startContainer);
      if (!startRoot || startRoot !== contentRootOf(range.endContainer)) {
        setSelectionDraft(null);
        return;
      }
      const textRange = rangeFromSelection(startRoot, range);
      const nodeEl = startRoot.closest<HTMLElement>('[data-node-order]');
      const sectionId = nodeEl?.dataset.sectionId;
      const segment = Number(nodeEl?.dataset.segment ?? Number.NaN);
      if (!textRange || !sectionId || !Number.isFinite(segment)) {
        setSelectionDraft(null);
        return;
      }
      setSelectionDraft({ sectionId, segment, range: textRange, placement: popoverPlacement(range.getBoundingClientRect()) });
    };
    const onFinish = () => window.setTimeout(evaluate, 0);
    root.addEventListener('mouseup', onFinish);
    root.addEventListener('touchend', onFinish);
    return () => {
      root.removeEventListener('mouseup', onFinish);
      root.removeEventListener('touchend', onFinish);
    };
  }, [prepared]);

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
    // §11.8/§11.10 activity: a downward scroll is forward reading (keeps forward-time eligible); an
    // upward scroll is still activity but not forward. The programmatic restore scroll (§2.4) is not
    // user activity, so it must not open an interval or accrue time.
    if (delta !== 0 && restorePhaseRef.current !== 'restoring') {
      sessionRef.current?.recordActivity(Date.now(), delta > 0);
    }
    lastScrollTop.current = root.scrollTop;
    setPopover(null);
    // Anchored overlays (§11.7) misalign once the page scrolls, so dismiss them like the note popover.
    setSelectionDraft(null);
    setHighlightEditor(null);
    // Debounced position report (§11.5): saves intra-node scroll position and grows the window
    // when the settled node changes.
    schedulePositionReport();
  };

  const jumpToOrder = (order: number) => {
    flushActivitySlice.current();
    scrollRoot.current?.querySelector<HTMLElement>(`[data-node-order="${order}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTocOpen(false);
    // §11.10: the settling scroll after this jump must not be credited as forward reading of the
    // skipped content. Mark the jump window and flush the session (node-change immediate submit, §11.8).
    jumpEndRef.current = Date.now() + JUMP_SETTLE_MS;
    // Explicit jump: this is the one place §2.1 allows an active save of a node's first block/offset 0.
    // Report the target now (with the top-of-node anchor) so its window is prioritized and the saved
    // position matches the jump before the scroll settles. clientObservedAt is stamped at click time
    // so a jump correctly wins over an earlier scroll observation that lands late (§2.3).
    const target = document.manifest.nodes.find((item) => item.order === order);
    reportFocus.current(order, target
      ? {
        sectionId: target.section_id,
        segment: target.segment,
        blockIndex: 1,
        offset: 0,
        clientObservedAt: new Date().toISOString(),
      }
      : undefined);
  };

  // §11.7 highlight CRUD. Highlights are held in local state (seeded from bootstrap) so a create/edit/
  // delete reflects immediately; each call reconciles the returned row into that state. Failures are
  // swallowed — a missed highlight is recoverable on reload and must never crash the reader.
  const clearNativeSelection = () => window.getSelection()?.removeAllRanges();
  const commitHighlight = async (
    target: { sectionId: string; segment: number; range: NodeRange },
    note: string | undefined,
  ): Promise<Highlight | null> => {
    try {
      const trimmed = note?.trim();
      const created = await createHighlight(document.userBookId, {
        sectionId: target.sectionId,
        segment: target.segment,
        range: target.range,
        ...(trimmed ? { note: trimmed } : {}),
      });
      setHighlights((current) => [...current, created]);
      return created;
    } catch {
      return null;
    }
  };
  const saveHighlightNote = async (highlightId: string, note: string): Promise<void> => {
    try {
      const updated = await updateHighlightNote(document.userBookId, highlightId, note.trim() ? note.trim() : null);
      setHighlights((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch {
      // keep the editor open so the reader can retry
    }
  };
  const removeHighlight = async (highlightId: string): Promise<void> => {
    try {
      await deleteHighlight(document.userBookId, highlightId);
      setHighlights((current) => current.filter((item) => item.id !== highlightId));
    } catch {
      // keep the editor open so the reader can retry
    }
  };
  // Toolbar actions: 划线 saves a plain highlight now; 划线+笔记 opens the note composer over the
  // selection (the highlight is created on save, in one call).
  const highlightSelection = () => {
    if (!selectionDraft) return;
    void commitHighlight(selectionDraft, undefined);
    setSelectionDraft(null);
    clearNativeSelection();
  };
  const composeHighlightNote = () => {
    if (!selectionDraft) return;
    setHighlightEditor({
      mode: 'create',
      sectionId: selectionDraft.sectionId,
      segment: selectionDraft.segment,
      range: selectionDraft.range,
      placement: selectionDraft.placement,
    });
    setSelectionDraft(null);
    setPopover(null);
  };
  const jumpToHighlight = (highlightId: string) => {
    flushActivitySlice.current();
    jumpEndRef.current = Date.now() + JUMP_SETTLE_MS;
    setBookInfoOpen(false);
    // A cross-block highlight renders one mark per block sharing the id; the first is its start.
    scrollRoot.current
      ?.querySelector<HTMLElement>(`[data-highlight-id="${highlightId}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
    // §11.7: click a highlight mark → open its note editor (view / edit note, delete note, delete
    // highlight). Annotation is checked first so an overlap favors opening the 裁读注.
    const highlightMark = (event.target as HTMLElement).closest<HTMLElement>('[data-highlight-id]');
    if (highlightMark?.dataset.highlightId) {
      const highlight = highlightById.get(highlightMark.dataset.highlightId);
      if (!highlight) return;
      setPopover(null);
      setSelectionDraft(null);
      setHighlightEditor({ mode: 'edit', highlight, placement: popoverPlacement(highlightMark.getBoundingClientRect()) });
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
    void flushActivitySlice.current(false, true);
    setSettingsOpen(false);
    setBookInfoOpen(false);
    setStatsOpen(false);
    setChromeHidden(false);
    setTocOpen(true);
  };
  const openSettings = () => {
    void flushActivitySlice.current(false, true);
    setTocOpen(false);
    setBookInfoOpen(false);
    setStatsOpen(false);
    setChromeHidden(false);
    setSettingsOpen(true);
  };
  const openBookInfo = () => {
    void flushActivitySlice.current(false, true);
    setTocOpen(false);
    setSettingsOpen(false);
    setStatsOpen(false);
    setChromeHidden(false);
    setBookInfoOpen(true);
  };
  const openStats = () => {
    void flushActivitySlice.current(false, true);
    setTocOpen(false);
    setSettingsOpen(false);
    setBookInfoOpen(false);
    setChromeHidden(false);
    setStatsOpen(true);
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
            <ReaderAction glyph="◔" label="统计" onClick={openStats} />
            <ReaderAction glyph="Aa" label="设置" onClick={openSettings} />
          </div>
        </header>
      </div>

      <nav className="reader-mobile-bar" data-hidden={chromeHidden} aria-label="阅读工具">
        <ReaderAction glyph="≡" label="目录" onClick={openToc} />
        <ReaderAction glyph="···" label="本书" onClick={openBookInfo} />
        <ReaderAction glyph="◔" label="统计" onClick={openStats} />
        <ReaderAction glyph="Aa" label="设置" onClick={openSettings} />
      </nav>

      {settingsOpen && <button className="reader-modal-scrim" type="button" onClick={() => setSettingsOpen(false)} aria-label="关闭阅读设置" />}
      {bookInfoOpen && <button className="reader-modal-scrim" type="button" onClick={() => setBookInfoOpen(false)} aria-label="关闭本书说明" />}
      {statsOpen && <button className="reader-modal-scrim" type="button" onClick={() => setStatsOpen(false)} aria-label="关闭阅读统计" />}
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
          highlights={highlights}
          jumpToHighlight={jumpToHighlight}
          close={() => setBookInfoOpen(false)}
        />
      )}
      {statsOpen && (
        <StatsPanel
          global={globalStats.data}
          book={bookStats.data}
          progressPercent={textProgress}
          loading={globalStats.isFetching || bookStats.isFetching}
          close={() => setStatsOpen(false)}
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
              {bookStats.data && bookStats.data.remaining.seconds !== null ? (
                <>
                  <i aria-hidden="true" />
                  <span>预计还需 {formatRemaining(bookStats.data.remaining)}</span>
                </>
              ) : null}
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
      {selectionDraft && !highlightEditor ? (
        <SelectionToolbar
          placement={selectionDraft.placement}
          onHighlight={highlightSelection}
          onHighlightWithNote={composeHighlightNote}
          onDismiss={() => {
            setSelectionDraft(null);
            clearNativeSelection();
          }}
        />
      ) : null}
      {highlightEditor ? (
        <HighlightPopover
          editor={highlightEditor}
          onSubmit={async (note) => {
            if (highlightEditor.mode === 'create') {
              await commitHighlight(highlightEditor, note);
              clearNativeSelection();
            } else {
              await saveHighlightNote(highlightEditor.highlight.id, note);
            }
            setHighlightEditor(null);
          }}
          onDeleteNote={async () => {
            if (highlightEditor.mode === 'edit') await saveHighlightNote(highlightEditor.highlight.id, '');
            setHighlightEditor(null);
          }}
          onDeleteHighlight={async () => {
            if (highlightEditor.mode === 'edit') await removeHighlight(highlightEditor.highlight.id);
            setHighlightEditor(null);
          }}
          onClose={() => {
            if (highlightEditor.mode === 'create') clearNativeSelection();
            setHighlightEditor(null);
          }}
        />
      ) : null}
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

function BookInfoPanel({ title, briefing, strategySummary, highlights, jumpToHighlight, close }: {
  title: string;
  briefing: Briefing;
  strategySummary: string;
  highlights: Highlight[];
  jumpToHighlight: (highlightId: string) => void;
  close: () => void;
}) {
  const hasBriefing = Object.values(briefing).some((section) => section.trim().length > 0);
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
      {/* §11.7 highlight list: quote snapshot + note, click to jump back to the original range. */}
      <section className="reader-highlight-list">
        <span>我的划线 · {highlights.length}</span>
        {highlights.length === 0 ? (
          <p className="reader-highlight-empty">在原文中选中文字即可划线，可附一条笔记。</p>
        ) : (
          <ul>
            {highlights.map((highlight) => (
              <li key={highlight.id}>
                <button type="button" onClick={() => jumpToHighlight(highlight.id)}>
                  <span className="reader-highlight-quote">{highlight.quoteSnapshot || '（无文字）'}</span>
                  {highlight.note ? <span className="reader-highlight-note">{highlight.note}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {!hasBriefing && !hasStrategy ? <p className="reader-book-info-empty">当前没有可展示的读前简报或处理方式。</p> : null}
    </aside>
  );
}

// §11.9 最近阅读时间 — compact local date + time, or a "not started" placeholder.
function formatLastRead(iso: string | null): string {
  if (!iso) return '尚未开始';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// §11.9 the reading-stats view: 全局 (今日/本周/累计/连续天数) + 本书 (累计/最近/进度/预计剩余). Data
// arrives via TanStack Query and refetches on open, so a session that just ended shows up immediately.
function StatsPanel({ global, book, progressPercent, loading, close }: {
  global: ReadingStatsGlobal | undefined;
  book: ReadingStatsPerBook | undefined;
  progressPercent: number;
  loading: boolean;
  close: () => void;
}) {
  return (
    <aside className="reader-stats" aria-label="阅读统计">
      <div className="reader-sheet-handle" aria-hidden="true" />
      <header><strong>阅读统计</strong><button type="button" onClick={close} aria-label="关闭阅读统计">×</button></header>
      <section className="reader-stats-group">
        <span className="reader-stats-title">全局</span>
        <div className="reader-stats-grid">
          <StatItem label="今日" value={global ? formatReadingDuration(global.todaySeconds) : '—'} />
          <StatItem label="本周" value={global ? formatReadingDuration(global.weekSeconds) : '—'} />
          <StatItem label="累计" value={global ? formatReadingDuration(global.totalSeconds) : '—'} />
          <StatItem label="连续阅读" value={global ? `${global.streakDays} 天` : '—'} />
        </div>
      </section>
      <section className="reader-stats-group">
        <span className="reader-stats-title">本书</span>
        <div className="reader-stats-grid">
          <StatItem label="累计时长" value={book ? formatReadingDuration(book.totalEffectiveSeconds) : '—'} />
          <StatItem label="最近阅读" value={formatLastRead(book?.lastReadAt ?? null)} />
          <StatItem label="全书进度" value={`${book?.progressPercent ?? progressPercent}%`} />
          <StatItem label="预计剩余" value={formatRemaining(book?.remaining)} />
        </div>
      </section>
      <p className="reader-stats-hint">{loading ? '正在更新…' : '统计仅计入正式阅读器内的有效阅读时间。'}</p>
    </aside>
  );
}

function StatItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="reader-stat-item">
      <span className="reader-stat-value">{value}</span>
      <span className="reader-stat-label">{label}</span>
    </div>
  );
}

// §11.7 the floating action toolbar over a fresh text selection. 问 AI is a disabled placeholder for
// phase 6; 划线 saves a plain highlight, 划线+笔记 opens the note composer. Reuses the note-dialog
// overlay/placement so it sits over the selection and dismisses on an outside click.
function SelectionToolbar({ placement, onHighlight, onHighlightWithNote, onDismiss }: {
  placement: PopoverPlacement;
  onHighlight: () => void;
  onHighlightWithNote: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="note-dialog-wrap" role="presentation" onClick={onDismiss}>
      <div
        className="reader-selection-toolbar"
        role="toolbar"
        aria-label="划线工具"
        data-placement={placement.placement}
        style={{
          left: placement.left,
          ...(placement.placement === 'above' ? { bottom: placement.edge } : { top: placement.edge }),
          '--note-caret-left': `${placement.caretLeft}px`,
        } as React.CSSProperties & { '--note-caret-left': string }}
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" disabled title="即将上线">问 AI</button>
        <button type="button" onClick={onHighlight}>划线</button>
        <button type="button" onClick={onHighlightWithNote}>划线 + 笔记</button>
      </div>
    </div>
  );
}

// §11.7 the highlight note editor. Create mode composes a note for a pending selection (saved in one
// call); edit mode views/edits an existing highlight's note with delete-note and delete-highlight.
function HighlightPopover({ editor, onSubmit, onDeleteNote, onDeleteHighlight, onClose }: {
  editor: HighlightEditorState;
  onSubmit: (note: string) => void;
  onDeleteNote: () => void;
  onDeleteHighlight: () => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState(editor.mode === 'edit' ? editor.highlight.note ?? '' : '');
  const quote = editor.mode === 'edit' ? editor.highlight.quoteSnapshot : null;
  const hasExistingNote = editor.mode === 'edit' && Boolean(editor.highlight.note);
  return (
    <div className="note-dialog-wrap" role="presentation" onClick={onClose}>
      <aside
        className="note-dialog highlight-editor"
        role="dialog"
        aria-label={editor.mode === 'create' ? '新建划线笔记' : '划线笔记'}
        data-placement={editor.placement.placement}
        style={{
          left: editor.placement.left,
          ...(editor.placement.placement === 'above' ? { bottom: editor.placement.edge } : { top: editor.placement.edge }),
          '--note-caret-left': `${editor.placement.caretLeft}px`,
        } as React.CSSProperties & { '--note-caret-left': string }}
        onClick={(event) => event.stopPropagation()}
      >
        <header><span><i aria-hidden="true" />划线 <em>Highlight</em></span></header>
        {quote ? <p className="highlight-editor-quote">{quote}</p> : null}
        <textarea
          className="highlight-editor-input"
          value={note}
          placeholder="写一条划线笔记（可留空）"
          rows={3}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          onChange={(event) => setNote(event.target.value)}
        />
        <div className="highlight-editor-actions">
          <button type="button" className="highlight-editor-primary" onClick={() => onSubmit(note)}>保存</button>
          {hasExistingNote ? <button type="button" onClick={onDeleteNote}>删除笔记</button> : null}
          {editor.mode === 'edit' ? (
            <button type="button" className="highlight-editor-danger" onClick={onDeleteHighlight}>删除划线</button>
          ) : null}
        </div>
      </aside>
    </div>
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
