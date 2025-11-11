export type Stage = 'infer' | 'segments' | 'analyze' | 'valueQs' | 'feasibility';

export const STAGE_ORDER: Stage[] = ['infer', 'segments', 'analyze', 'valueQs', 'feasibility'];

export type Policy = 'conservative' | 'standard' | 'aggressive';

export type AnalysisDimension = 'D1' | 'D2' | 'D3' | 'D4';

export type FeedbackIntent =
  | 'domain_correction'
  | 'segment_rescore'
  | 'segment_edit'
  | 'segment_add'
  | 'segment_remove'
  | 'segment_rename'
  | 'segment_merge'
  | 'analysis_recore'
  | 'analysis_edit'
  | 'analysis_rename'
  | 'value_question_rescore'
  | 'value_question_edit'
  | 'value_question_add'
  | 'value_question_remove';

export interface FeedbackChange {
  intent: FeedbackIntent;
  target: 'domain' | 'segments' | 'analysis' | 'valueQuestions';
  selector?: string | string[];
  dimension?: AnalysisDimension;
  questionId?: string;
  delta?: number;
  scopeAll?: boolean;
  confidence: number;
  metadata?: Record<string, unknown>;
  feedback_text?: string;
  current_segmentId?: string;
}

export interface RouterRequest {
  baseRunId: string;
  policy: Policy;
  changes: FeedbackChange[];
}

export interface RouterPlan {
  baseRunId: string;
  policy: Policy;
  mrf: Stage | null;
  scope: 'all' | string[];
  propagate: Stage[];
  steps: Stage[];
  expectedActions: string[];
  artifactImpacts: string[];
}

export interface ScopeResolutionOptions {
  required?: boolean;
  allowAll?: boolean;
}

export interface ScopeResolution {
  scope: 'all' | string[];
}

export type ScopeSelector = string | string[] | undefined;

export interface ScopeResolver {
  resolve(selector: ScopeSelector, options?: ScopeResolutionOptions): ScopeResolution;
}

export interface RouterDependencies {
  scopeResolver: ScopeResolver;
  baselineValidator?: (runId: string) => boolean;
}
