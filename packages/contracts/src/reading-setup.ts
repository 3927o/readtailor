/** Defines the canonical reading-setup artifacts shared by persistence and Agent tools. */

import { type Static, Type } from '@sinclair/typebox';

export const BookReaderProfileSchema = Type.Object({
  purpose: Type.String({ minLength: 1 }),
  existingKnowledge: Type.Array(Type.String({ minLength: 1 })),
  desiredDepthOrOutcome: Type.String({ minLength: 1 }),
  likelyObstacles: Type.Array(Type.String({ minLength: 1 })),
  expectedCommitment: Type.String({ minLength: 1 }),
  otherConclusions: Type.Array(Type.String({ minLength: 1 })),
});
export type BookReaderProfile = Static<typeof BookReaderProfileSchema>;

// Shared by the full setup Strategy and a ProposedStrategy that has no trial candidates.
export const READING_STRATEGY_CORE_FIELDS = {
  goals: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  expressionPrinciples: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  guide: Type.Object({
    enabled: Type.Boolean(),
    objectives: Type.Array(Type.String({ minLength: 1 })),
  }),
  annotations: Type.Object({
    enabled: Type.Boolean(),
    focuses: Type.Array(Type.String({ minLength: 1 })),
    exclusions: Type.Array(Type.String({ minLength: 1 })),
  }),
  afterReading: Type.Object({
    enabled: Type.Boolean(),
    objectives: Type.Array(Type.String({ minLength: 1 })),
  }),
};

// Fields stay lenient on read so migrated legacy text remains valid; writers may be stricter.
export const BriefingSchema = Type.Object({
  bookIdentity: Type.String(),
  arc: Type.String(),
  assumedKnowledge: Type.String(),
  readingAdvice: Type.String(),
});
export type Briefing = Static<typeof BriefingSchema>;

// Persisted until the user confirms it, then promoted into a full Strategy with candidates.
export const ProposedStrategySchema = Type.Object(READING_STRATEGY_CORE_FIELDS);
export type ProposedStrategy = Static<typeof ProposedStrategySchema>;
