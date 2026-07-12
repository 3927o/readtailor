/* ReadTailor · Reader — the slide-in AI companion + the Aa settings popover.
   Both are faked (no real LLM); the AI gives a canned, brand-voiced reply. */

function AiPanel({ open, quote, loc, onClose }) {
  const [msgs, setMsgs] = React.useState([]);
  const [draft, setDraft] = React.useState('');

  React.useEffect(() => { if (open) { setMsgs([]); setDraft(''); } }, [open, quote]);

  function ask(text) {
    if (!text.trim()) return;
    const canned = '这句话的字面是在跟太阳说话，但其实是查拉图斯特拉在说他自己——太阳因为有万物接受它的光才幸福，他也一样：攒了十年的智慧，必须被人接收才有意义。这就是他下山的理由。要我再就「下降」这个双关展开一点吗？';
    setMsgs((m) => [...m, { who: 'user', text }, { who: 'ai', text: canned }]);
    setDraft('');
  }

  return (
    <React.Fragment>
      <div onClick={onClose} style={{
        position: 'fixed', inset: 0, background: 'rgba(20,28,22,0.30)', zIndex: 215,
        opacity: open ? 1 : 0, pointerEvents: open ? 'auto' : 'none', transition: 'opacity 220ms',
      }} />
      <aside style={{
        position: 'fixed', top: 0, right: 0, height: '100%', width: 420, maxWidth: '92vw', zIndex: 220,
        background: 'var(--rt-bg)', borderLeft: '1px solid var(--rt-rule)',
        boxShadow: '0 0 60px -14px rgba(20,40,30,0.5)',
        transform: open ? 'none' : 'translateX(102%)', transition: 'transform 280ms cubic-bezier(.4,0,.2,1)',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 18px 13px', borderBottom: '1px solid var(--rt-rule)' }}>
          <span style={{ fontFamily: 'var(--rt-serif)', fontSize: 16, fontWeight: 700, color: 'var(--rt-green-deep)' }}>✦ 问问 AI</span>
          <button onClick={onClose} aria-label="关闭" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, lineHeight: 1, color: 'var(--rt-ink-3)' }}>×</button>
        </div>

        <div style={{ padding: '14px 18px 0' }}>
          <div style={{ fontFamily: 'var(--rt-mono)', fontSize: 10, letterSpacing: '0.08em', color: 'var(--rt-green)', marginBottom: 7 }}>{loc || '查拉图斯特拉的前言 · 1'}</div>
          <div style={{
            fontFamily: 'var(--rt-serif)', fontSize: 14, lineHeight: 1.7, color: 'var(--rt-ink-2)', fontStyle: 'italic',
            background: 'var(--rt-green-soft)', borderLeft: '3px solid var(--rt-green)', borderRadius: '0 8px 8px 0',
            padding: '11px 14px', maxHeight: 124, overflow: 'auto',
          }}>{quote || '如果没有你所照耀的人们，你有何幸福可言哩！'}</div>
        </div>

        {msgs.length === 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, padding: '13px 18px 4px' }}>
            {['这句/这段在说什么？', '为什么是「下降」？', '他在反驳谁？'].map((q) => (
              <button key={q} onClick={() => ask(q)} style={{
                fontFamily: 'var(--rt-demo)', fontSize: 12.5, color: 'var(--rt-green-deep)',
                background: 'var(--rt-bg-card)', border: '1px solid var(--rt-rule)', borderRadius: 999,
                padding: '6px 13px', cursor: 'pointer',
              }}>{q}</button>
            ))}
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px 8px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {msgs.map((m, i) => m.who === 'user' ? (
            <div key={i} style={{
              alignSelf: 'flex-end', maxWidth: '85%', background: 'var(--rt-green)', color: '#fff',
              fontFamily: 'var(--rt-demo)', fontSize: 14, lineHeight: 1.65, padding: '9px 14px',
              borderRadius: '14px 14px 4px 14px',
            }}>{m.text}</div>
          ) : (
            <div key={i} style={{ alignSelf: 'stretch', fontFamily: 'var(--rt-read)', fontSize: 15, lineHeight: 1.85, color: 'var(--rt-ink)' }}>{m.text}</div>
          ))}
        </div>

        <form onSubmit={(e) => { e.preventDefault(); ask(draft); }} style={{
          display: 'flex', alignItems: 'flex-end', gap: 9, padding: '12px 16px 16px', borderTop: '1px solid var(--rt-rule)',
        }}>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={1}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(draft); } }}
            placeholder="追问点什么…（Enter 发送）" style={{
              flex: 1, resize: 'none', fontFamily: 'var(--rt-demo)', fontSize: 14, lineHeight: 1.5, color: 'var(--rt-ink)',
              background: 'var(--rt-bg-card)', border: '1px solid var(--rt-rule)', borderRadius: 12, padding: '10px 13px', outline: 'none',
            }} />
          <button type="submit" aria-label="发送" style={{
            flex: 'none', width: 38, height: 38, borderRadius: '50%', border: 'none',
            background: 'var(--rt-green)', color: '#fff', fontSize: 18, cursor: 'pointer',
          }}>↑</button>
        </form>
      </aside>
    </React.Fragment>
  );
}

function SettingsPopover({ open, settings, onChange }) {
  const seg = (label, key, opts) => (
    <div style={{ marginBottom: 15 }}>
      <div style={{ fontFamily: 'var(--rt-mono)', fontSize: 9, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--rt-ink-3)', marginBottom: 8 }}>{label}</div>
      <div style={{ display: 'flex', gap: 6 }}>
        {opts.map(([v, l]) => {
          const on = settings[key] === v;
          return (
            <button key={l} onClick={() => onChange(key, v)} style={{
              flex: 1, fontFamily: 'var(--rt-demo)', fontSize: 13, cursor: 'pointer',
              color: on ? '#fff' : 'var(--rt-ink-2)', background: on ? 'var(--rt-green)' : 'var(--rt-bg-2)',
              border: '1px solid transparent', borderRadius: 8, padding: '7px 0', fontWeight: on ? 600 : 400,
            }}>{l}</button>
          );
        })}
      </div>
    </div>
  );
  return (
    <div style={{
      position: 'absolute', top: 50, right: 0, width: 262, zIndex: 60,
      background: 'var(--rt-bg-card)', border: '1px solid var(--rt-rule)', borderRadius: 14,
      boxShadow: '0 18px 40px -14px rgba(25,40,30,0.4)', padding: '16px 18px',
      opacity: open ? 1 : 0, transform: open ? 'none' : 'translateY(-6px) scale(0.98)',
      transformOrigin: 'top right', pointerEvents: open ? 'auto' : 'none', transition: 'opacity 160ms, transform 160ms',
    }}>
      {seg('字号', 'size', [['16px', '小'], ['', '标准'], ['20px', '大'], ['22px', '特大']])}
      {seg('行距', 'lh', [['1.7', '紧'], ['', '标准'], ['2.25', '松']])}
      {seg('页宽', 'width', [['620px', '窄'], ['', '标准'], ['860px', '宽']])}
    </div>
  );
}

Object.assign(window, { AiPanel, SettingsPopover });
