import type { CSSProperties } from 'react';
import { AssistanceContent } from '../user-books/components';

// One anchored dialog serves both reader surfaces: the original book note (raw HTML,
// preserved verbatim) and the tailored 裁读注 (a markdown-ish content string rendered
// through AssistanceContent). The positioning fields are identical; only the body differs.
export type PopoverBody =
  | { kind: 'note'; html: string }
  | { kind: 'tailored'; content: string };

export interface ActivePopover {
  body: PopoverBody;
  left: number;
  edge: number;
  caretLeft: number;
  placement: 'above' | 'below';
}

export function popoverPlacement(rect: DOMRect): Omit<ActivePopover, 'body'> {
  const popoverWidth = Math.min(392, window.innerWidth - 32);
  const anchorCenter = rect.left + rect.width / 2;
  const left = Math.max(16, Math.min(anchorCenter - popoverWidth / 2, window.innerWidth - popoverWidth - 16));
  const placement: 'above' | 'below' = window.innerHeight - rect.bottom < 280 && rect.top > 280 ? 'above' : 'below';
  return {
    left,
    edge: placement === 'above' ? window.innerHeight - rect.top + 8 : rect.bottom + 8,
    caretLeft: Math.max(24, Math.min(anchorCenter - left, popoverWidth - 24)),
    placement,
  };
}

export function NotePopover({ popover, close }: { popover: ActivePopover | null; close: () => void }) {
  if (!popover) return null;
  const tailored = popover.body.kind === 'tailored';
  return (
    <div className="note-dialog-wrap" role="presentation" onClick={close}>
      <aside
        className="note-dialog"
        role="dialog"
        aria-label={tailored ? '裁读注' : '原书注'}
        data-placement={popover.placement}
        data-variant={popover.body.kind}
        style={{
          left: popover.left,
          ...(popover.placement === 'above' ? { bottom: popover.edge } : { top: popover.edge }),
          '--note-caret-left': `${popover.caretLeft}px`,
        } as CSSProperties & { '--note-caret-left': string }}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <span>
            <i aria-hidden="true" />
            {tailored ? <>裁读注 <em>Tailored note</em></> : <>原书注 <em>Book note</em></>}
          </span>
        </header>
        {popover.body.kind === 'tailored' ? (
          <div className="note-dialog-content">
            <AssistanceContent content={popover.body.content} />
          </div>
        ) : (
          <div className="note-dialog-content rt-reader-note-content" dangerouslySetInnerHTML={{ __html: popover.body.html }} />
        )}
      </aside>
    </div>
  );
}
