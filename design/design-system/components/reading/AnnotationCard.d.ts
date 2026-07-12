import React from 'react';

export type AnnotationKind = 'lead' | 'margin' | 'fillin';

export interface AnnotationCardProps extends React.HTMLAttributes<HTMLElement> {
  /** Which annotation voice. @default 'lead' */
  kind?: AnnotationKind;
  /** Kicker label override (defaults: 章节导读 / 脉络 / 推理补全). */
  kicker?: string;
  /** Title line (used by `lead`). */
  title?: string;
  /** Anchored phrase (used by `margin`). */
  anchor?: string;
  /** "触发 · …" provenance line. */
  trigger?: string;
  /** Bullet list (used by `lead`). */
  bullets?: string[];
  /** Free body content (used by `margin` / `fillin`). */
  children?: React.ReactNode;
}

/**
 * The AI's note beside the text — lead-in, margin note, or fill-in.
 *
 * @startingPoint section="Reading" subtitle="Lead-in / margin / fill-in annotation" viewport="700x220"
 */
export function AnnotationCard(props: AnnotationCardProps): JSX.Element;
