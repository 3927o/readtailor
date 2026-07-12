/* ReadTailor · Reader — the reading view shell.
   Composes the design-system primitives (Mark, AnnotationCard, BriefCard,
   ProgressBar) into the product's "全本陪读" page. */

const DS = window.ReadTailorDesignSystem_39423e;

function ReaderApp() {
  const { Mark, AnnotationCard, BriefCard, ProgressBar } = DS;
  const brief = window.READER_BRIEF;
  const units = window.READER_UNITS;
  const TYPELABELS = window.READER_TYPELABELS;

  const [progress, setProgress] = React.useState(8);
  const [pop, setPop] = React.useState(null);          // {x,y,type,content}
  const [ai, setAi] = React.useState(null);            // {quote,loc} | null
  const [setOpen, setSetOpen] = React.useState(false);
  const [settings, setSettings] = React.useState({ size: '', lh: '', width: '' });
  const [briefOpen, setBriefOpen] = React.useState(true);
  const scrollRef = React.useRef(null);

  function onScroll(e) {
    const el = e.currentTarget;
    const max = el.scrollHeight - el.clientHeight;
    setProgress(max > 0 ? (el.scrollTop / max) * 100 : 0);
    if (pop) setPop(null);
  }

  function openMark(e, seg) {
    const r = e.currentTarget.getBoundingClientRect();
    setPop({ x: Math.min(r.left, window.innerWidth - 360), y: r.bottom + 8, type: seg.type, content: seg.content, anchor: seg.t });
  }

  const bodySize = settings.size || '18px';
  const bodyLh = settings.lh || '1.95';
  const wrapW = settings.width || '720px';

  return (
    <div style={{ minHeight: '100%', background: 'var(--rt-bg)', position: 'relative' }}>
      <ProgressBar value={progress} gradient />

      {/* tools */}
      <div style={{ position: 'fixed', top: 14, right: 16, zIndex: 130, display: 'flex', gap: 8 }}>
        <ToolBtn onClick={() => {}}>≡&nbsp;目录</ToolBtn>
        <div style={{ position: 'relative' }}>
          <ToolBtn onClick={() => setSetOpen((v) => !v)} active={setOpen}>Aa</ToolBtn>
          <window.SettingsPopover open={setOpen} settings={settings} onChange={(k, v) => setSettings((s) => ({ ...s, [k]: v }))} />
        </div>
      </div>

      <div ref={scrollRef} onScroll={onScroll} style={{ height: '100vh', overflowY: 'auto' }}>
        <div style={{ maxWidth: wrapW, margin: '0 auto', padding: '46px 24px 160px', transition: 'max-width 200ms' }}>

          {/* masthead */}
          <header style={{ borderBottom: '1px solid var(--rt-rule)', paddingBottom: 20, marginBottom: 8 }}>
            <div style={{ fontFamily: 'var(--rt-serif)', fontSize: 20, fontWeight: 700, letterSpacing: '-0.01em' }}>
              裁读 <em style={{ fontStyle: 'italic', fontWeight: 400, color: 'var(--rt-ink-2)', marginLeft: 8, fontSize: 12, letterSpacing: '0.14em' }}>· ReadTailor</em>
            </div>
            <h1 style={{ fontFamily: 'var(--rt-serif)', fontSize: 34, fontWeight: 700, margin: '18px 0 6px', letterSpacing: '-0.01em' }}>查拉图斯特拉如是说</h1>
            <div style={{ fontFamily: 'var(--rt-mono)', fontSize: 10, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--rt-ink-3)' }}>
              <span style={{ color: 'var(--rt-green)' }}>·</span>&nbsp;&nbsp;弗里德里希·尼采 · 全本陪读
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 18 }}>
              {brief.profile.map((c, i) => (
                <span key={i} style={{ background: 'var(--rt-green-soft)', color: 'var(--rt-green-deep)', borderRadius: 999, padding: '5px 12px', fontFamily: 'var(--rt-demo)', fontSize: 12 }}>
                  {c[0]} <b style={{ fontWeight: 700 }}>{c[1]}</b>{c[2] || ''}
                </span>
              ))}
            </div>
          </header>

          {/* brief (collapsible) */}
          <div style={{ margin: '34px 0 8px' }}>
            <BriefCard
              title={brief.title}
              sections={briefOpen ? brief.sections.filter((s) => !s.terms) : []}
              terms={briefOpen ? (brief.sections.find((s) => s.terms) || {}).terms?.map(([term, gloss]) => ({ term, gloss })) : []}
            />
            <button onClick={() => setBriefOpen((v) => !v)} style={{
              marginTop: 10, fontFamily: 'var(--rt-mono)', fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase',
              color: 'var(--rt-green)', background: 'none', border: 'none', cursor: 'pointer',
            }}>{briefOpen ? '收起简报 ▲' : '展开简报 ▼'}</button>
          </div>

          {/* reading */}
          <div style={{ marginTop: 48 }}>
            <div style={{ fontFamily: 'var(--rt-mono)', fontSize: 10, letterSpacing: '0.3em', textTransform: 'uppercase', color: 'var(--rt-ink-3)', textAlign: 'center', marginBottom: 8 }}>个 性 化 铺 路 · 全 本</div>
            <div style={{ fontFamily: 'var(--rt-demo)', fontSize: 12.5, color: 'var(--rt-ink-3)', textAlign: 'center', marginBottom: 30 }}>原文一字不改 · 点带虚线的词/句看注释（释义 / 推理补全 / 脉络）</div>

            <h2 style={{ fontFamily: 'var(--rt-serif)', fontSize: 30, fontWeight: 700, textAlign: 'center', margin: '30px 0 8px' }}>第一部</h2>
            <h3 style={{ fontFamily: 'var(--rt-serif)', fontSize: 21, fontWeight: 700, color: 'var(--rt-green-deep)', margin: '44px 0 6px', textAlign: 'center' }}>查拉图斯特拉的前言</h3>

            {units.map((u, ui) => (
              <section key={ui} style={{ margin: '30px 0' }}>
                <div style={{ fontFamily: 'var(--rt-mono)', fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--rt-green)', borderTop: '1px solid var(--rt-rule-2)', paddingTop: 22, marginBottom: 14 }}>{u.no}</div>
                <AnnotationCard kind="lead" kicker="章节导读 · 始终展开" title={u.lead.title}>
                  {u.lead.text}
                </AnnotationCard>
                {u.paras.map((para, pi) => (
                  <p key={pi} style={{ fontFamily: 'var(--rt-read)', fontSize: bodySize, lineHeight: bodyLh, color: 'var(--rt-ink)', textIndent: '2em', margin: '0 0 14px', textAlign: 'justify' }}>
                    {para.map((seg, si) => typeof seg === 'string'
                      ? seg
                      : <Mark key={si} type={seg.type} active={pop && pop.anchor === seg.t} onActivate={(e) => openMark(e, seg)}>{seg.t}</Mark>
                    )}
                  </p>
                ))}
              </section>
            ))}

            <p style={{ fontFamily: 'var(--rt-read)', fontSize: bodySize, lineHeight: bodyLh, color: 'var(--rt-ink-3)', textAlign: 'center', marginTop: 40, fontStyle: 'italic' }}>… 划选任意句子，或点一个注释，向 AI 追问。</p>
          </div>
        </div>
      </div>

      {/* floating ask-AI */}
      <button onClick={() => setAi({ quote: '如果没有你所照耀的人们，你有何幸福可言哩！', loc: '查拉图斯特拉的前言 · 1' })} style={{
        position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)', zIndex: 80,
        fontFamily: 'var(--rt-demo)', fontSize: 14.5, fontWeight: 600, color: '#fff', background: 'var(--rt-green)',
        border: 'none', borderRadius: 999, padding: '13px 26px', cursor: 'pointer',
        boxShadow: '0 12px 34px -8px rgba(31,77,58,0.7)',
      }}>✦&nbsp;就这段问问 AI</button>

      {/* mark popover */}
      {pop && (
        <div style={{
          position: 'fixed', left: pop.x, top: pop.y, zIndex: 100, maxWidth: 340, minWidth: 220,
          background: 'var(--rt-bg-card)', border: '1px solid var(--rt-rule)', borderRadius: 11,
          borderTop: `2px solid ${pop.type === 'margin' ? 'var(--rt-mark-margin)' : pop.type === 'fillin' ? 'var(--rt-mark-fillin)' : 'var(--rt-green)'}`,
          padding: '13px 15px 14px', boxShadow: 'var(--rt-shadow-pop)', fontFamily: 'var(--rt-serif)',
        }}>
          <span style={{ fontFamily: 'var(--rt-mono)', fontSize: 9, letterSpacing: '0.16em', textTransform: 'uppercase', fontWeight: 700, color: pop.type === 'margin' ? 'var(--rt-mark-margin)' : pop.type === 'fillin' ? 'var(--rt-mark-fillin)' : 'var(--rt-green)', display: 'block', marginBottom: 7 }}>{TYPELABELS[pop.type]}</span>
          <div style={{ fontSize: 14.5, lineHeight: 1.74, color: 'var(--rt-ink)' }}>{pop.content}</div>
          <button onClick={() => setPop(null)} style={{ position: 'absolute', top: 8, right: 10, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--rt-ink-3)', fontSize: 16, lineHeight: 1 }}>×</button>
        </div>
      )}

      <window.AiPanel open={!!ai} quote={ai && ai.quote} loc={ai && ai.loc} onClose={() => setAi(null)} />
    </div>
  );
}

function ToolBtn({ children, onClick, active }) {
  return (
    <button onClick={onClick} style={{
      fontFamily: 'var(--rt-mono)', fontSize: 11, letterSpacing: '0.06em', color: 'var(--rt-green-deep)',
      background: active ? '#fff' : 'rgba(255,255,255,0.86)', backdropFilter: 'blur(8px)',
      border: `1px solid ${active ? 'var(--rt-green)' : 'var(--rt-rule)'}`, borderRadius: 999, padding: '7px 13px',
      cursor: 'pointer', boxShadow: '0 4px 14px -8px rgba(20,40,30,0.4)',
    }}>{children}</button>
  );
}

Object.assign(window, { ReaderApp });
