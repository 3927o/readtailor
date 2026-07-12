import React from 'react';

export interface BriefSection {
  label: string;
  text: React.ReactNode;
  /** Flag the personalised reading-prep section (green wash). */
  prep?: boolean;
}

export interface BriefTerm {
  term: string;
  gloss: React.ReactNode;
}

export interface BriefCardProps extends React.HTMLAttributes<HTMLElement> {
  /** Kicker label. @default '读之前的简报' */
  kicker?: string;
  /** Card title. */
  title?: string;
  /** Stacked label + body sections; flag one `prep` for the green wash. */
  sections?: BriefSection[];
  /** Optional term → gloss glossary rows. */
  terms?: BriefTerm[];
}

/**
 * Read-before-you-start briefing for a book.
 *
 * @startingPoint section="Reading" subtitle="Read-before briefing card" viewport="700x420"
 */
export function BriefCard(props: BriefCardProps): JSX.Element;
