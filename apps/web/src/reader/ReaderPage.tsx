import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ProgressBar } from '../components/chrome/ProgressBar';
import { Segmented } from '../components/core/Segmented';
import { Slider } from '../components/core/Slider';
import { AnnotationList, AssistanceContent, BriefCard } from '../user-books/components';
import { getReaderBootstrap, getReaderDocument, reportReaderFocus } from './api';
import type { ReaderNodeEnhancement, ReaderOutlineItem } from './api';
import { getFragmentTargetId, getOutlineDepth, prepareBookContent } from './content';
import type { OriginalNote, RenderedHeading, RenderedNode } from './content';

type ThemeSetting = 'system' | 'paper' | 'night';
type ContentWidthSetting = 'narrow' | 'medium' | 'wide';

interface ReaderSettings {
  fontSize: number;
  lineHeight: number;
  contentWidth: ContentWidthSetting;
  theme: ThemeSetting;
}

interface ActiveNote {
  note: OriginalNote;
  left: number;
  edge: number;
  caretLeft: number;
  placement: 'above' | 'below';
}

const defaultSettings: ReaderSettings = {
  fontSize: 18,
  lineHeight: 1.95,
  contentWidth: 'medium',
  theme: 'system',
};

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
  const [settings, setSettings] = useState(defaultSettings);
  const [tocOpen, setTocOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bookInfoOpen, setBookInfoOpen] = useState(false);
  const [currentOrder, setCurrentOrder] = useState(document.manifest.nodes[0]?.order ?? 1);
  const [note, setNote] = useState<ActiveNote | null>(null);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [chromeHidden, setChromeHidden] = useState(false);
  const scrollRoot = useRef<HTMLDivElement>(null);
  const lastScrollTop = useRef(0);
  const enhancementAnchor = useRef<{ order: number; top: number } | undefined>(undefined);
  const prefersDark = usePrefersDark();
  const theme = resolvedTheme(settings.theme, prefersDark);
  const queryClient = useQueryClient();
  // Report the reading position so the host keeps the lazy-loading window generating and raises
  // the target's priority on a jump (§6.2 / PRD §11.3). The returned bootstrap surfaces newly
  // queued enhancements; the layout-anchor effect below keeps the scroll position stable.
  const focus = useMutation({
    mutationFn: (order: number) => reportReaderFocus(document.userBookId, order),
    onSuccess: (bootstrap) => queryClient.setQueryData(['reader-bootstrap', document.userBookId], bootstrap),
  });
  const reportedOrder = useRef<number | null>(null);
  const reportFocus = useRef<(order: number) => void>(() => {});
  reportFocus.current = (order: number) => {
    if (!Number.isFinite(order) || reportedOrder.current === order) return;
    reportedOrder.current = order;
    focus.mutate(order);
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

  useLayoutEffect(() => {
    const root = scrollRoot.current;
    const node = root?.querySelector<HTMLElement>(`[data-node-order="${currentOrder}"]`);
    if (!root || !node) return;
    const top = node.getBoundingClientRect().top;
    const previous = enhancementAnchor.current;
    if (previous?.order === currentOrder) {
      root.scrollTop += top - previous.top;
    }
    enhancementAnchor.current = { order: currentOrder, top: node.getBoundingClientRect().top };
  }, [currentOrder, enhancementVersion]);
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

  // Debounce scroll-driven position reports so the window follows the reader without spamming
  // the host; jumps report immediately (below) for an instant 提权.
  useEffect(() => {
    const handle = window.setTimeout(() => reportFocus.current(currentOrder), 700);
    return () => window.clearTimeout(handle);
  }, [currentOrder]);

  useEffect(() => {
    const closeOverlays = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setTocOpen(false);
      setSettingsOpen(false);
      setBookInfoOpen(false);
      setNote(null);
    };
    window.addEventListener('keydown', closeOverlays);
    return () => window.removeEventListener('keydown', closeOverlays);
  }, []);

  useEffect(() => {
    const closeNote = () => setNote(null);
    window.addEventListener('resize', closeNote);
    return () => window.removeEventListener('resize', closeNote);
  }, []);

  const handleScroll = () => {
    const root = scrollRoot.current;
    if (!root) return;
    const max = root.scrollHeight - root.clientHeight;
    setScrollProgress(max > 0 ? (root.scrollTop / max) * 100 : 0);
    const delta = root.scrollTop - lastScrollTop.current;
    if (delta > 4 && root.scrollTop > 180 && !tocOpen && !settingsOpen && !bookInfoOpen && !note) {
      setChromeHidden(true);
    } else if ((delta < -4 || root.scrollTop < 120) && chromeHidden) {
      setChromeHidden(false);
    }
    lastScrollTop.current = root.scrollTop;
    setNote(null);
  };

  const jumpToOrder = (order: number) => {
    scrollRoot.current?.querySelector<HTMLElement>(`[data-node-order="${order}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTocOpen(false);
    // Explicit jump: report the target now so its window is prioritized before the scroll settles.
    reportFocus.current(order);
  };

  const handleContentClick = (event: React.MouseEvent<HTMLElement>) => {
    setChromeHidden(false);
    const tailoredAnchor = (event.target as HTMLElement).closest<HTMLElement>('[data-annotation-id]');
    if (tailoredAnchor?.dataset.annotationId) {
      globalThis.document.getElementById(`tailored-annotation-${tailoredAnchor.dataset.annotationId}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
      const rect = anchor.getBoundingClientRect();
      const popoverWidth = Math.min(392, window.innerWidth - 32);
      const anchorCenter = rect.left + rect.width / 2;
      const left = Math.max(16, Math.min(anchorCenter - popoverWidth / 2, window.innerWidth - popoverWidth - 16));
      const placement = window.innerHeight - rect.bottom < 280 && rect.top > 280 ? 'above' : 'below';
      setNote({
        note: originalNote,
        left,
        edge: placement === 'above' ? window.innerHeight - rect.top + 8 : rect.bottom + 8,
        caretLeft: Math.max(24, Math.min(anchorCenter - left, popoverWidth - 24)),
        placement,
      });
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
      <NoteDialog note={note} close={() => setNote(null)} />
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
      <AnnotationList annotations={content?.annotations ?? []} />
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

function NoteDialog({ note, close }: { note: ActiveNote | null; close: () => void }) {
  if (!note) return null;
  return (
    <div className="note-dialog-wrap" role="presentation" onClick={close}>
      <aside
        className="note-dialog"
        role="dialog"
        aria-label="原书注"
        data-placement={note.placement}
        style={{
          left: note.left,
          ...(note.placement === 'above' ? { bottom: note.edge } : { top: note.edge }),
          '--note-caret-left': `${note.caretLeft}px`,
        } as React.CSSProperties & { '--note-caret-left': string }}
        onClick={(event) => event.stopPropagation()}
      >
        <header><span><i aria-hidden="true" />原书注 <em>Book note</em></span></header>
        <div className="note-dialog-content rt-reader-note-content" dangerouslySetInnerHTML={{ __html: note.note.html }} />
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
