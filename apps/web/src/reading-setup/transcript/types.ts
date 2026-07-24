/** Defines the backend-neutral ordered transcript rendered by the formal reading-setup UI. */

export type ReadingSetupRenderState =
  | 'streaming'
  | 'working'
  | 'ready'
  | 'failed';

export type ReadingSetupActionState =
  | 'available'
  | 'submitting'
  | 'completed'
  | 'superseded';

export interface AssistantTranscriptEntry {
  id: string;
  kind: 'assistant';
  text: string;
  streaming: boolean;
}

export interface UserTranscriptEntry {
  id: string;
  kind: 'user';
  text: string;
  delivery: 'sending' | 'sent' | 'failed';
}

export interface QuestionOptionView {
  id: string;
  label: string;
}

export interface QuestionAnswerView {
  selectedOptionIds: string[];
  freeText: string | null;
  displayText: string;
}

export interface QuestionTranscriptEntry {
  id: string;
  kind: 'question';
  toolCallId: string;
  renderState: ReadingSetupRenderState;
  prompt?: string;
  hint?: string;
  options: QuestionOptionView[];
  streamingPart?: 'prompt' | 'hint' | 'options';
  allowFreeText?: boolean;
  answer?: QuestionAnswerView;
  error?: string;
}

export interface QueryTranscriptEntry {
  id: string;
  kind: 'query';
  toolCallId: string;
  renderState: Extract<ReadingSetupRenderState, 'streaming' | 'working' | 'failed'>;
  activity: string;
  error?: string;
}

export interface ProfileTranscriptEntry {
  id: string;
  kind: 'profile';
  toolCallId: string;
  renderState: ReadingSetupRenderState;
}

export interface BriefDraftView {
  bookIdentity?: string;
  arc?: string;
  assumedKnowledge?: string;
  readingAdvice?: string;
}

export interface BriefTranscriptEntry {
  id: string;
  kind: 'brief';
  toolCallId: string;
  renderState: ReadingSetupRenderState;
  brief: BriefDraftView;
  streamingField?: keyof BriefDraftView;
  error?: string;
}

export interface StrategyDraftView {
  goals?: string[];
  expressionPrinciples?: string[];
  guide?: {
    enabled?: boolean;
    objectives?: string[];
  };
  annotations?: {
    enabled?: boolean;
    focuses?: string[];
    exclusions?: string[];
  };
  afterReading?: {
    enabled?: boolean;
    objectives?: string[];
  };
}

export interface StrategyTranscriptEntry {
  id: string;
  kind: 'strategy';
  toolCallId: string;
  renderState: ReadingSetupRenderState;
  summary?: string;
  strategy?: StrategyDraftView;
  streamingSection?: 'summary' | 'goals' | 'readingSupport' | 'restraint';
  confirmation: ReadingSetupActionState;
  error?: string;
}

export interface TrialTextSegmentView {
  text: string;
  annotationId?: string;
}

export interface TrialParagraphView {
  id: string;
  segments: TrialTextSegmentView[];
}

export interface TrialAnnotationView {
  id: string;
  label: string;
  content: string;
}

export interface TrialTranscriptEntry {
  id: string;
  kind: 'trial';
  toolCallId: string;
  renderState: ReadingSetupRenderState;
  reason?: string;
  titlePath: string[];
  paragraphs: TrialParagraphView[];
  guide?: string;
  annotations: TrialAnnotationView[];
  afterReading?: string;
  confirmation: ReadingSetupActionState;
  error?: string;
}

export interface NoticeTranscriptEntry {
  id: string;
  kind: 'notice';
  tone: 'quiet' | 'warning' | 'error';
  message: string;
  action?: {
    kind: 'retry_connection';
    label: string;
  };
}

export interface GenericToolTranscriptEntry {
  id: string;
  kind: 'tool';
  toolCallId: string;
  toolName: string;
  renderState: ReadingSetupRenderState;
  error?: string;
}

export type ReadingSetupTranscriptEntry =
  | AssistantTranscriptEntry
  | UserTranscriptEntry
  | QuestionTranscriptEntry
  | QueryTranscriptEntry
  | ProfileTranscriptEntry
  | BriefTranscriptEntry
  | StrategyTranscriptEntry
  | TrialTranscriptEntry
  | GenericToolTranscriptEntry
  | NoticeTranscriptEntry;
