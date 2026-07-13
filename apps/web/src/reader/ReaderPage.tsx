import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ProgressBar } from '../components/chrome/ProgressBar';
import { Segmented } from '../components/core/Segmented';
import { Slider } from '../components/core/Slider';
import { getReaderDocument } from './api';
import type { ReaderOutlineItem } from './api';
import { getOutlineDepth, prepareBookContent } from './content';
import type { OriginalNote, RenderedNode } from './content';

type ThemeSetting = 'system' | 'paper' | 'night';

interface ReaderSettings {
  fontSize: number;
  lineHeight: number;
  contentWidth: number;
  theme: ThemeSetting;
}

const defaultSettings: ReaderSettings = {
  fontSize: 18,
  lineHeight: 1.95,
  contentWidth: 720,
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

export function ReaderPage() {
  const { bookId = '' } = useParams();
  const query = useQuery({
    queryKey: ['reader-document', bookId],
    queryFn: () => getReaderDocument(bookId),
    enabled: Boolean(bookId),
  });

  if (query.isPending) {
    return <ReaderStatus title="正在展开书页" detail="正文与目录正在从书籍包中读取。" />;
  }
  if (query.isError) {
    return <ReaderStatus title="这本书暂时打不开" detail={query.error.message} retry={() => void query.refetch()} />;
  }

  return <Reader document={query.data} />;
}

function Reader({ document }: { document: Awaited<ReturnType<typeof getReaderDocument>> }) {
  const [settings, setSettings] = useState(defaultSettings);
  const [tocOpen, setTocOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [currentOrder, setCurrentOrder] = useState(document.manifest.nodes[0]?.order ?? 1);
  const [note, setNote] = useState<OriginalNote | null>(null);
  const [scrollProgress, setScrollProgress] = useState(0);
  const scrollRoot = useRef<HTMLDivElement>(null);
  const prefersDark = usePrefersDark();
  const theme = resolvedTheme(settings.theme, prefersDark);
  const prepared = useMemo(
    () => prepareBookContent(
      document.html,
      document.manifest.nodes,
      document.manifest.outline,
      document.assetBaseUrl,
    ),
    [document],
  );
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

  useEffect(() => {
    const closeOverlays = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setTocOpen(false);
      setSettingsOpen(false);
      setNote(null);
    };
    window.addEventListener('keydown', closeOverlays);
    return () => window.removeEventListener('keydown', closeOverlays);
  }, []);

  const handleScroll = () => {
    const root = scrollRoot.current;
    if (!root) return;
    const max = root.scrollHeight - root.clientHeight;
    setScrollProgress(max > 0 ? (root.scrollTop / max) * 100 : 0);
    setNote(null);
  };

  const jumpToOrder = (order: number) => {
    scrollRoot.current?.querySelector<HTMLElement>(`[data-node-order="${order}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTocOpen(false);
  };

  const handleContentClick = (event: React.MouseEvent<HTMLElement>) => {
    const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
    if (!anchor) return;
    const targetId = anchor.getAttribute('href')?.replace(/^#/, '');
    if (!targetId) return;
    const originalNote = prepared.notes.get(targetId);
    if (originalNote) {
      event.preventDefault();
      setNote(originalNote);
      return;
    }
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
    setTocOpen(true);
  };
  const openSettings = () => {
    setTocOpen(false);
    setSettingsOpen(true);
  };

  return (
    <div className="reader-shell" data-rt-theme={theme === 'night' ? 'night' : undefined}>
      <ProgressBar value={scrollProgress} aria-label="阅读滚动进度" />
      <div className="reader-chrome">
        <header className="reader-toolbar">
          <Link className="reader-back-button" to="/" aria-label="返回书架" title="返回书架">‹</Link>
          <div className="reader-title" title={document.book.title}>{document.book.title}</div>
          <div className="reader-desktop-actions">
            <ReaderAction glyph="≡" label="目录" onClick={openToc} />
            <ReaderAction glyph="Aa" label="设置" onClick={openSettings} />
          </div>
        </header>
      </div>

      <nav className="reader-mobile-bar" aria-label="阅读工具">
        <ReaderAction glyph="≡" label="目录" onClick={openToc} />
        <ReaderAction glyph="Aa" label="阅读设置" onClick={openSettings} />
      </nav>

      {settingsOpen && <button className="reader-modal-scrim" type="button" onClick={() => setSettingsOpen(false)} aria-label="关闭阅读设置" />}
      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          update={(patch) => setSettings((current) => ({ ...current, ...patch }))}
          close={() => setSettingsOpen(false)}
        />
      )}

      <div ref={scrollRoot} className="reader-scroll" onScroll={handleScroll}>
        <main
          className="reader-page"
          style={{
            '--reader-font-size': `${settings.fontSize}px`,
            '--reader-line-height': settings.lineHeight,
            '--reader-content-width': `${settings.contentWidth}px`,
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

function ReadingNode({ node, bookTitle }: { node: RenderedNode; bookTitle: string }) {
  return (
    <section className="reader-node" data-node-order={node.order} id={`reader-node-${node.order}`}>
      {node.headings.filter((heading) => heading.title.trim() !== bookTitle.trim()).map((heading) => (
        <div
          key={heading.section_id}
          className="reader-outline-heading"
          data-outline-type={heading.data_type}
        >
          {heading.title}
        </div>
      ))}
      <div className="reader-original" dangerouslySetInnerHTML={{ __html: node.html }} />
    </section>
  );
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
        <Slider label="字号" min={15} max={24} value={settings.fontSize} onChange={(fontSize) => update({ fontSize })} showValue format={(value) => `${value}px`} />
      </div>
      <div className="reader-setting-row reader-setting-wide">
        <span>行距</span>
        <Slider label="行距" min={1.55} max={2.35} step={0.1} value={settings.lineHeight} onChange={(lineHeight) => update({ lineHeight })} showValue format={(value) => value.toFixed(2)} />
      </div>
      <div className="reader-setting-row reader-setting-wide">
        <span>版心</span>
        <Slider label="正文宽度" min={560} max={880} step={40} value={settings.contentWidth} onChange={(contentWidth) => update({ contentWidth })} showValue format={(value) => `${value}px`} />
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

function NoteDialog({ note, close }: { note: OriginalNote | null; close: () => void }) {
  if (!note) return null;
  return (
    <div className="note-dialog-wrap" role="presentation" onClick={close}>
      <aside className="note-dialog" role="dialog" aria-modal="true" aria-label="原书注" onClick={(event) => event.stopPropagation()}>
        <div className="reader-sheet-handle" aria-hidden="true" />
        <header><span>原书注 · Book note</span><button type="button" onClick={close} aria-label="关闭原书注">×</button></header>
        <div dangerouslySetInnerHTML={{ __html: note.html }} />
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
