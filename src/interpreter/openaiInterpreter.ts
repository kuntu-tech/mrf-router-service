import OpenAI from 'openai';

import config from '../config';
import type { AnalysisDimension, FeedbackChange, FeedbackIntent } from '../types';
import { interpreterResponseSchema } from './schema';

export interface InterpretInput {
  feedbackText: string;
  baseRunId?: string;
  current_data?: Record<string, unknown>;
  currentSegmentId?: string;
}

const openaiApiKeyEnv = config.openai.apiKeyEnv;

function assertApiKey(): string {
  const key = process.env[openaiApiKeyEnv];
  if (!key) {
    throw new Error(
      `Missing OpenAI API key. Please set ${openaiApiKeyEnv} in your environment to enable the interpreter.`,
    );
  }
  return key;
}

function buildPrompt(input: InterpretInput) {
  const segmentsSummary =
    input.current_data && input.current_data['segments']
      ? `Known segments: ${JSON.stringify(input.current_data['segments'])}`
      : 'Segments: unknown';
  const currentSegmentSummary = input.currentSegmentId
    ? `Current segment context: ${input.currentSegmentId}`
    : 'Current segment context: unspecified';

  return [
    {
      role: 'system' as const,
      content:
        'You are the Feedback Interpreter for the BusinessInsight MRF router. Think of every change as a precise tool call and emit only the JSON payload the router can execute.\n' +
        'Toolbox (targets & selectors must match exactly):\n' +
        'Domain:\n' +
        '  • domain_correction → target `domain`, selector `domain` (rewrite the overall domain scope).\n' +
        '    Keywords: "domain shift", "update market definition", "expand scope", "narrow domain".\n' +
        'Segments (target `segment`):\n' +
        '  • segment_add → selector `segments` (optionally include virtual IDs/metadata for the new segment).\n' +
        '    Treat any instruction to add/introduce/expand to a new market, audience, buyer group, or consumer persona as segment addition even if the word "segment" is absent.\n' +
        '    Examples: "add a consumer market", "move towards the 2C market", "target pound buyers with a new audience".\n' +
        '  • segment_edit → selector `segments[segmentId=seg_X]` (regenerate one specific segment; ID or name required).\n' +
        '    Use when feedback references improving an existing segment without changing count.\n' +
        '  • segment_merge → selector array such as `["segments[segmentId=seg_a]", "segments[segmentId=seg_b]"]` (merge multiple segments into one outcome).\n' +
        '    Keywords: "merge", "combine", "consolidate", "fold X into Y".\n' +
        '  • segment_remove → selector `segments[segmentId=seg_X]` (deleting demands the exact ID).\n' +
        '    Trigger when you see "remove/delete/drop segment X".\n' +
        '  • segment_rescore → selector `segments` (rescore the full set; never a single ID).\n' +
        '    Keywords: "rescore all segments", "rerun segment scoring".\n' +
        '  • segment_rename → selector `segments[segmentId=seg_X]` (include new label in metadata).\n' +
        '    Trigger when the request is only changing the label/title.\n' +
        'Analysis (target `analysis`):\n' +
        '  • analysis_edit → selector `segments[segmentId=seg_X].analysis.Dn` (edit a specific dimension; set `dimension = Dn`).\n' +
        '    Keywords: "tweak D2 persona", "update analysis for dimension D1", "adjust score".\n' +
        '  • analysis_recore → selector `segments[segmentId=seg_X].analysis` (re-score D1–D4 for that segment at once).\n' +
        '    Keywords: "rescore all analysis dimensions", "rerun analysis scoring".\n' +
        '  • analysis_rename → selector `segments[segmentId=seg_X].analysis.Dn` (rename the dimension label only).\n' +
        'Value questions (target `valueQuestions`):\n' +
        '  • value_question_add → selector `segments[segmentId=seg_X].valueQuestions` (append a new question).\n' +
        '    Keywords: "add question", "we need another question about X".\n' +
        '  • value_question_edit → selector `segments[segmentId=seg_X].valueQuestions[id=q_X]` (update one question; ID required).\n' +
        '    Trigger when editing copy or details of an existing question.\n' +
        '  • value_question_remove → selector `segments[segmentId=seg_X].valueQuestions[id=q_X]` (remove that exact question).\n' +
        '  • value_question_rescore → selector `segments[segmentId=seg_X].valueQuestions` (regenerate the entire question list).\n' +
        '    Keywords: "rescore value questions", "rerun question scoring", "refresh all questions".\n' +
        'Targets & selectors:\n' +
        '- Targets must be one of: domain, segments, analysis, valueQuestions.\n' +
        '- When the feedback refers to brand-new segments, there may be no ID. Use selector `segments` and optionally include metadata describing the new segment.\n' +
        '- For merges, always emit an array of selectors listing each source segment.\n' +
        '- Use TRL selectors such as `segments[segmentId=seg_01]`, `segments[name=Fashion].valueQuestions`, or arrays of selectors for merge operations. Prefer IDs/names supplied in current_data; otherwise infer from the text.\n' +
        '- Analysis selectors must include `.analysis.Dn`; always set the matching `dimension` field.\n' +
        'Interpretation rules:\n' +
        '- Rely on the user goal to choose tools; never enumerate hypothetical prompts.\n' +
        '- Support multi-command feedback by returning multiple change objects in the order given.\n' +
        '- Carry forward the literal `feedback_text` for every change and propagate numeric hints such as `delta` when stated.\n' +
        'Validation:\n' +
        '- Confidence must be within [0,1]; drop or skip changes below the router threshold (0.6).\n' +
        '- Always return syntactically valid JSON matching the schema, without Markdown fences.\n' +
        '- The response structure is `{ \"changes\": [...], \"reasoning\"?: string[] }`.\n' +
        'Produce only the JSON payload with `changes` (and optional `reasoning`).',
    },
    {
      role: 'user' as const,
      content: `Feedback: ${input.feedbackText}\nBase run: ${input.baseRunId ?? 'unknown'}\n${segmentsSummary}\n${currentSegmentSummary}`,
    },
  ];
}

export async function interpretFeedback(input: InterpretInput): Promise<{
  changes: FeedbackChange[];
  reasoning?: string[];
}> {
  const apiKey = assertApiKey();
  const client = new OpenAI({ apiKey });

  const prompt = buildPrompt(input);
  const segmentsContext = extractSegmentsFromCurrentData(input.current_data);
  console.log(prompt);
  const response = await client.responses.create({
    model: config.interpreter.model,
    temperature: 0.1,
    input: prompt,
  });

  const jsonPayload = sanitizeJson(extractJsonText(response));
  const normalizationContext: NormalizationContext = {
    segments: segmentsContext,
    feedbackText: input.feedbackText,
  };
  if (input.currentSegmentId) {
    normalizationContext.currentSegmentId = input.currentSegmentId;
  }

  const normalizedPayload = normalizeInterpreterResponse(JSON.parse(jsonPayload), normalizationContext);
  const parsed = interpreterResponseSchema.safeParse(normalizedPayload);
  if (!parsed.success) {
    throw new Error(`Failed to parse interpreter output: ${parsed.error.message}`);
  }

  const base = {
    changes: parsed.data.changes as FeedbackChange[],
  };

  return parsed.data.reasoning ? { ...base, reasoning: parsed.data.reasoning } : base;
}

function extractJsonText(response: unknown): string {
  const candidate = response as {
    output?: Array<{ content?: Array<{ type: string; text?: string }> }>;
    output_text?: string[];
  };

  if (Array.isArray(candidate.output)) {
    for (const item of candidate.output) {
      if (item && Array.isArray(item.content)) {
        for (const chunk of item.content) {
          if (chunk && chunk.type === 'output_text' && chunk.text) {
            return chunk.text;
          }
        }
      }
    }
  }

  if (Array.isArray(candidate.output_text) && candidate.output_text.length > 0) {
    return candidate.output_text.join('\n');
  }

  throw new Error('Interpreter response did not contain text content.');
}

function sanitizeJson(payload: string): string {
  const trimmed = payload.trim();
  if (trimmed.startsWith('```')) {
    const lines = trimmed.split('\n');
    if (lines.length <= 2) {
      return trimmed.replace(/```/g, '').trim();
    }
    const lastLine = lines[lines.length - 1] ?? '';
    const removeTail = lastLine.startsWith('```');
    const body = lines.slice(1, removeTail ? -1 : undefined);
    return body.join('\n').trim();
  }
  return trimmed;
}

const allowedTargets = ['domain', 'segments', 'analysis', 'valueQuestions'] as const;

type AllowedTarget = (typeof allowedTargets)[number];

type SegmentValueQuestionContext = {
  id?: string;
  question?: string;
};

type SegmentContext = {
  id?: string;
  name?: string;
  index?: number;
  labels: string[];
  valueQuestions: SegmentValueQuestionContext[];
};

interface NormalizationContext {
  segments?: SegmentContext[];
  currentSegmentId?: string;
  feedbackText?: string;
}

function normalizeInterpreterResponse(payload: unknown, context?: NormalizationContext): unknown {
  if (Array.isArray(payload)) {
    const firstObject = payload.find((item) => item && typeof item === 'object');
    if (!firstObject) {
      return payload;
    }
    return normalizeInterpreterResponse(firstObject, context);
  }

  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const clone = { ...(payload as Record<string, unknown>) };
  const normalizedChanges = normalizeChangesArray(clone);
  const mapped = normalizedChanges.map((change) => normalizeChange(change, context));
  propagateSegmentContext(mapped);
  clone.changes = mapped;

  return clone;
}

const changeAliases = ['commands', 'actions', 'updates', 'changeList', 'items'];

function normalizeChangesArray(payload: Record<string, unknown>): unknown[] {
  if (Array.isArray(payload.changes)) {
    return payload.changes;
  }

  for (const alias of changeAliases) {
    const candidate = payload[alias];
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  if (looksLikeChange(payload)) {
    const clone = { ...payload };
    delete clone.reasoning;
    return [clone];
  }

  return [];
}

function looksLikeChange(payload: Record<string, unknown>): boolean {
  const intent = payload.intent;
  const target = payload.target;
  return typeof intent === 'string' && typeof target === 'string';
}

function normalizeChange(change: unknown, context?: NormalizationContext): unknown {
  if (!change || typeof change !== 'object') {
    return change;
  }

  const candidate = { ...(change as Record<string, unknown>) };
  if (typeof candidate.feedback_text !== 'string' || candidate.feedback_text.trim().length === 0) {
    if (context?.feedbackText) {
      candidate.feedback_text = context.feedbackText;
    }
  }
  const explicitSegmentId = coerceSegmentId(candidate['current_segmentId']);
  const contextSegmentId = coerceSegmentId(context?.currentSegmentId);
  if (explicitSegmentId) {
    candidate['current_segmentId'] = explicitSegmentId;
  } else if (contextSegmentId) {
    candidate['current_segmentId'] = contextSegmentId;
  }

  const normalizedDimension = normalizeAnalysisDimension(candidate.dimension, candidate.feedback_text);
  if (normalizedDimension) {
    candidate.dimension = normalizedDimension;
    if (!candidate.target) {
      candidate.target = 'analysis';
    }
    if (!isLegacyIntent(candidate.intent)) {
      candidate.intent = 'analysis_edit';
    }
  } else if (candidate.dimension !== undefined && candidate.dimension !== null) {
    delete candidate.dimension;
  }

  ensureSegmentTargetFromFeedback(candidate, context?.segments);
  const safeTarget = ensureAllowedTargetValue(candidate.target, candidate.selector, candidate.feedback_text);
  candidate.target = safeTarget;
  candidate.intent = ensureCanonicalIntentValue(candidate.intent, safeTarget, candidate.feedback_text);

  enforceValueQuestionIntentHeuristics(candidate);

  if (typeof candidate.confidence !== 'number') {
    candidate.confidence = config.interpreter.confidenceThreshold ?? 0.8;
  }

  enforceSegmentSelectorRequirements(candidate, context?.segments);
  enforceSegmentRenameSelectorRequirements(candidate, context?.segments);
  enforceAnalysisSelectorRequirements(candidate, context?.segments);
  enforceValueQuestionAddSelectorRequirements(candidate, context?.segments);
  enforceValueQuestionSelectorRequirements(candidate, context?.segments);
  ensureDefaultSelectors(candidate);
  applySegmentAdditionFallback(candidate);

  if (!isLegacyIntent(candidate.intent)) {
    candidate.intent = ensureCanonicalIntentValue(candidate.intent, candidate.target as AllowedTarget, candidate.feedback_text);
  }

  return candidate;
}

function coerceSegmentId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const dimensionHintPatterns: Array<{ pattern: RegExp; dimension: AnalysisDimension }> = [
  {
    pattern:
      /\bmarket\s+(size|share|opportunity|potential|demand|growth)\b|\b(total\s+addressable\s+market|tam)\b/i,
    dimension: 'D1',
  },
  { pattern: /\bcustomer\b|\bpersona\b|\buser\s+profile\b/i, dimension: 'D2' },
  { pattern: /\bconversion\b|\bwin\s+rate\b|\bpipeline\b/i, dimension: 'D3' },
  { pattern: /\bcompetitive\b|\bcompetition\b|\bmoat\b/i, dimension: 'D4' },
];

function normalizeAnalysisDimension(
  value: unknown,
  feedbackText: unknown,
): AnalysisDimension | undefined {
  const literal = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (isAllowedDimensionLiteral(literal)) {
    return literal as AnalysisDimension;
  }

  const fromValue = inferDimensionFromText(value);
  if (fromValue) {
    return fromValue;
  }

  return inferDimensionFromText(feedbackText);
}

function inferDimensionFromText(payload: unknown): AnalysisDimension | undefined {
  if (typeof payload !== 'string') {
    return undefined;
  }
  const text = payload.toLowerCase();
  for (const hint of dimensionHintPatterns) {
    if (hint.pattern.test(text)) {
      return hint.dimension;
    }
  }
  return undefined;
}

function isAllowedDimensionLiteral(value: string): value is AnalysisDimension {
  return value === 'D1' || value === 'D2' || value === 'D3' || value === 'D4';
}

function inferTargetFromKeywords(feedbackText: unknown, selector: unknown): AllowedTarget | undefined {
  const text = typeof feedbackText === 'string' ? feedbackText.toLowerCase() : '';
  const selectorText = typeof selector === 'string' ? selector.toLowerCase() : '';

  if (/\bvalue\s+question\b|\bquestion\b/.test(text) || selectorText.includes('valuequestions')) {
    return 'valueQuestions';
  }
  if (selectorText.includes('.analysis')) {
    return 'analysis';
  }
  if (selectorText.includes('segments[') || matchesSegmentKeyword(selectorText)) {
    return 'segments';
  }

  if (matchesSegmentKeyword(text) && hasSegmentAdditionCue(text)) {
    return 'segments';
  }

  return undefined;
}

function normalizeTarget(value: unknown): AllowedTarget | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const lower = trimmed.toLowerCase();
  for (const target of allowedTargets) {
    if (lower === target.toLowerCase()) {
      return target;
    }
  }

const heuristics: Array<[RegExp, AllowedTarget]> = [
  [/domain/, 'domain'],
  [/segment/, 'segments'],
  [/\bmarket(s)?\b/, 'segments'],
  [/\baudience(s)?\b/, 'segments'],
  [/\bconsumer\s+market(s)?\b/, 'segments'],
  [/\b(b2c|2c)\s+market(s)?\b/, 'segments'],
  [/analysis/, 'analysis'],
  [/value[_\-\s]?question/, 'valueQuestions'],
];

  for (const [pattern, target] of heuristics) {
    if (pattern.test(lower)) {
      return target;
    }
  }

  return undefined;
}

const legacyIntents = new Set<FeedbackIntent>([
  'domain_correction',
  'segment_rescore',
  'segment_edit',
  'segment_add',
  'segment_remove',
  'segment_rename',
  'segment_merge',
  'analysis_recore',
  'analysis_edit',
  'analysis_rename',
  'value_question_rescore',
  'value_question_edit',
  'value_question_add',
  'value_question_remove',
]);

function isLegacyIntent(value: unknown): value is FeedbackIntent {
  return typeof value === 'string' && legacyIntents.has(value as FeedbackIntent);
}

function canonicalizeIntent(
  intent: unknown,
  target: AllowedTarget | undefined,
): FeedbackIntent | undefined {
  if (typeof intent !== 'string') {
    return undefined;
  }
  const trimmed = intent.trim();
  if (!trimmed) {
    return undefined;
  }

  if (legacyIntents.has(trimmed as FeedbackIntent)) {
    return trimmed as FeedbackIntent;
  }

  const lower = trimmed.toLowerCase();
  switch (lower) {
    case 'add':
      return mapAddIntent(target);
    case 'edit':
      return mapEditIntent(target);
    case 'rename':
      return mapRenameIntent(target);
    case 'remove':
      return mapRemoveIntent(target);
    default:
      break;
  }

  const heuristicIntent = mapHeuristicIntent(lower, target);
  if (heuristicIntent) {
    return heuristicIntent;
  }

  if (target) {
    return fallbackIntentForTarget(target);
  }

  return undefined;
}

function mapAddIntent(target: AllowedTarget | undefined): FeedbackIntent {
  switch (target) {
    case 'segments':
      return 'segment_add';
    case 'analysis':
      return 'analysis_edit';
    case 'valueQuestions':
      return 'value_question_add';
    case 'domain':
      return 'domain_correction';
    default:
      return 'analysis_edit';
  }
}

function mapEditIntent(target: AllowedTarget | undefined): FeedbackIntent {
  switch (target) {
    case 'analysis':
      return 'analysis_edit';
    case 'segments':
      return 'segment_edit';
    case 'valueQuestions':
      return 'value_question_edit';
    case 'domain':
      return 'domain_correction';
    default:
      return 'analysis_edit';
  }
}

function mapRenameIntent(target: AllowedTarget | undefined): FeedbackIntent {
  switch (target) {
    case 'segments':
      return 'segment_rename';
    case 'valueQuestions':
      return 'value_question_edit';
    default:
      return 'analysis_edit';
  }
}

function mapRemoveIntent(target: AllowedTarget | undefined): FeedbackIntent {
  switch (target) {
    case 'segments':
      return 'segment_remove';
    case 'valueQuestions':
      return 'value_question_remove';
    default:
      return 'analysis_edit';
  }
}

const segmentKeywordNeedles = [
  'segment',
  'segments',
  'market',
  'markets',
  'consumer market',
  'consumer markets',
  'consumer segment',
  'consumer segments',
  'audience',
  'audiences',
  'buyer group',
  'buyer groups',
  '2c market',
  'b2c market',
] as const;

const normalizedSegmentKeywordNeedles = segmentKeywordNeedles
  .map((needle) => normalizeForIntentMatching(needle))
  .filter((value) => value.length > 0);

const segmentAdditionCues = [
  'add',
  'introduce',
  'create',
  'launch',
  'expand into',
  'expanding into',
  'expand to',
  'expanding to',
  'enter',
  'entering',
  'move into',
  'moving into',
  'move toward',
  'moving toward',
  'move towards',
  'moving towards',
  'shift to',
  'shifting to',
  'shift toward',
  'shifting toward',
  'go after',
  'going after',
  'target',
  'targeting',
  'pursue',
  'pursuing',
  'missing segment',
  'missing a segment',
  'missing market',
  'missing a market',
] as const;

const normalizedSegmentAdditionCues = segmentAdditionCues
  .map((cue) => normalizeForIntentMatching(cue))
  .filter((value) => value.length > 0);

function matchesSegmentKeyword(text: string): boolean {
  return matchesAny(text, Array.from(segmentKeywordNeedles));
}

function hasSegmentAdditionCue(text: string): boolean {
  const normalized = normalizeForIntentMatching(text);
  if (!normalized) {
    return false;
  }
  for (const addition of normalizedSegmentAdditionCues) {
    const additionIndex = normalized.indexOf(addition);
    if (additionIndex === -1) {
      continue;
    }
    for (const keyword of normalizedSegmentKeywordNeedles) {
      const keywordIndex = normalized.indexOf(keyword);
      if (keywordIndex === -1) {
        continue;
      }
      if (keywordIndex > additionIndex) {
        return true;
      }
    }
  }
  return false;
}

function mapHeuristicIntent(
  lowerIntent: string,
  target: AllowedTarget | undefined,
): FeedbackIntent | undefined {
  const normalized = normalizeForIntentMatching(lowerIntent);

  if (matchesAny(normalized, ['value question', 'value questions', 'valuequestions', 'question'])) {
    if (matchesAny(normalized, ['rescore', 're score', 'rerun scoring', 'rerun', 're run'])) {
      return 'value_question_rescore';
    }
    if (matchesAny(normalized, ['add', 'increase', 'more', 'raise', 'grow', 'expand', 'plus', 'new'])) {
      return 'value_question_add';
    }
    if (matchesAny(normalized, ['remove', 'delete', 'drop', 'fewer', 'less', 'eliminate'])) {
      return 'value_question_remove';
    }
    if (
      matchesAny(normalized, ['edit', 'update', 'modify', 'change', 'set', 'adjust', 'rewrite', 'retitle'])
    ) {
      return 'value_question_edit';
    }
  }

  if (target === 'segments' || matchesSegmentKeyword(normalized)) {
    if (
      hasSegmentAdditionCue(lowerIntent) ||
      matchesAny(normalized, [
        'missing segment',
        'missing segments',
        'missing market',
        'missing markets',
        'add segment',
        'add segments',
        'add market',
        'add markets',
        'create segment',
        'create segments',
        'create market',
        'create markets',
        'new segment',
        'new segments',
        'new market',
        'new markets',
        'introduce segment',
        'introduce segments',
        'introduce market',
        'introduce markets',
        'need another segment',
        'need another segments',
        'need another market',
        'need another markets',
        'need a segment',
        'need a segments',
        'need a market',
        'need a markets',
      ])
    ) {
      return 'segment_add';
    }
    if (
      matchesAny(normalized, [
        'rescore',
        're score',
        'rescore segments',
        'rescore markets',
        'rerun scoring',
        'rerun segments',
        'rerun markets',
        'recompute segments',
        'recompute markets',
      ])
    ) {
      return 'segment_rescore';
    }
    if (matchesAny(normalized, ['merge', 'combine', 'consolidate', 'fold', 'unify'])) {
      return 'segment_merge';
    }
    if (matchesAny(normalized, ['rename', 'retitle', 'relabel'])) {
      return 'segment_rename';
    }
    if (matchesAny(normalized, ['scope', 'retarget', 'refocus'])) {
      return 'segment_edit';
    }
  }

  if (matchesAny(normalized, ['analysis', 'score', 'dimension', 'd1', 'd2', 'd3', 'd4']) || target === 'analysis') {
    if (matchesAny(normalized, ['rescore', 're score', 'rerun scoring', 'rerun analysis', 'recompute'])) {
      return 'analysis_recore';
    }
    if (matchesAny(normalized, ['rename', 'retitle', 'relabel'])) {
      return 'analysis_rename';
    }
    return 'analysis_edit';
  }

  if (target === 'valueQuestions') {
    return 'value_question_edit';
  }

  if (target === 'segments' && matchesAny(normalized, ['remove', 'delete', 'sunset', 'drop'])) {
    return 'segment_remove';
  }

  return undefined;
}

function matchesAny(text: string, needles: string[]): boolean {
  const normalizedText = normalizeForIntentMatching(text);
  return needles.some((needle) => normalizedText.includes(normalizeForIntentMatching(needle)));
}

function normalizeForIntentMatching(text: string): string {
  return text
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fallbackIntentForTarget(target: AllowedTarget): FeedbackIntent {
  switch (target) {
    case 'domain':
      return 'domain_correction';
    case 'segments':
      return 'segment_edit';
    case 'analysis':
      return 'analysis_edit';
    case 'valueQuestions':
      return 'value_question_edit';
  }
}

interface FallbackLogPayload {
  fallback: FeedbackIntent;
  target: AllowedTarget;
  rawIntent: unknown;
  feedbackText?: string;
}

function logFallbackIntent(payload: FallbackLogPayload): void {
  if (process.env.NODE_ENV === 'test') {
    return;
  }
  const { fallback, target, rawIntent, feedbackText } = payload;
  console.warn('[interpreter:fallback-intent]', {
    fallback,
    target,
    rawIntent,
    feedbackText,
  });
}

function inferIntentFromFeedback(
  feedbackText: unknown,
  target: AllowedTarget | undefined,
): FeedbackIntent | undefined {
  const rawText = typeof feedbackText === 'string' ? feedbackText : '';
  const normalized = rawText.toLowerCase();
  const normalizedForIntent = normalizeForIntentMatching(rawText);

  if (normalizedForIntent) {
    if (indicatesSegmentAddition(normalizedForIntent, target)) {
      return 'segment_add';
    }
    if (indicatesSegmentMerge(normalizedForIntent)) {
      return 'segment_merge';
    }
    if (indicatesSegmentRescore(normalizedForIntent, target)) {
      return 'segment_rescore';
    }
    if (indicatesValueQuestionRescore(normalizedForIntent, target)) {
      return 'value_question_rescore';
    }
    if (indicatesAnalysisRecore(normalizedForIntent, target)) {
      return 'analysis_recore';
    }
  }

  if (normalized && indicatesSegmentScopeRestriction(normalized)) {
    return 'segment_edit';
  }
  const dimension = inferDimensionFromText(feedbackText);
  if (dimension) {
    return 'analysis_edit';
  }
  if (target) {
    return fallbackIntentForTarget(target);
  }
  return undefined;
}

function indicatesSegmentScopeRestriction(text: string): boolean {
  if (!text) {
    return false;
  }
  return (
    /\bonly\s+(want|need|plan|intend)\s+to\s+keep\b/.test(text) ||
    /\bkeep\s+only\b/.test(text) ||
    /\bonly\s+keep\b/.test(text) ||
    /\bremove\s+(everything|everyone)\s+but\b/.test(text) ||
    /\bexcept\b.+\bkeep\b/.test(text)
  );
}

function indicatesSegmentAddition(text: string, target: AllowedTarget | undefined): boolean {
  if (!text) {
    return false;
  }
  if (target !== undefined && target !== 'segments' && !matchesSegmentKeyword(text)) {
    return false;
  }
  if (!matchesSegmentKeyword(text)) {
    return false;
  }
  if (hasSegmentAdditionCue(text)) {
    return true;
  }
  return matchesAny(text, [
    'add segment',
    'add segments',
    'add market',
    'add markets',
    'introduce segment',
    'introduce segments',
    'introduce market',
    'introduce markets',
    'create segment',
    'create segments',
    'create market',
    'create markets',
    'launch segment',
    'launch segments',
    'launch market',
    'launch markets',
  ]);
}

function indicatesSegmentMerge(text: string): boolean {
  if (!text) {
    return false;
  }
  if (!matchesSegmentKeyword(text)) {
    return false;
  }
  return matchesAny(text, ['merge', 'combine', 'consolidate', 'fold', 'unify']);
}

function indicatesSegmentRescore(text: string, target: AllowedTarget | undefined): boolean {
  if (!text) {
    return false;
  }
  if (target && target !== 'segments' && !matchesSegmentKeyword(text)) {
    return false;
  }
  if (!matchesSegmentKeyword(text)) {
    return false;
  }
  if (matchesAny(text, ['value question', 'value questions']) || matchesAny(text, ['analysis', 'dimension'])) {
    return false;
  }
  return matchesAny(text, ['rescore', 're score', 'rerun', 'recompute']);
}

function indicatesAnalysisRecore(text: string, target: AllowedTarget | undefined): boolean {
  if (!text) {
    return false;
  }
  if (target === 'analysis') {
    return text.includes('rescore') || text.includes('rerun') || text.includes('recompute');
  }
  return text.includes('rescore') && matchesAny(text, ['analysis', 'dimension', 'score']);
}

function indicatesValueQuestionRescore(text: string, target: AllowedTarget | undefined): boolean {
  if (!text) {
    return false;
  }
  if (target && target !== 'valueQuestions' && !matchesAny(text, ['value question', 'value questions'])) {
    return false;
  }
  return (
    text.includes('rescore') ||
    text.includes('rerun') ||
    matchesAny(text, ['refresh value questions', 'recompute value questions'])
  );
}

function inferTargetFromSelector(selector: unknown): AllowedTarget | undefined {
  const selectorValue = Array.isArray(selector) ? selector.join(' ') : selector;
  if (typeof selectorValue !== 'string') {
    return undefined;
  }

  const lower = selectorValue.toLowerCase();
  if (lower.includes('valuequestion') || lower.includes('value_questions')) {
    return 'valueQuestions';
  }
  if (lower.includes('analysis')) {
    return 'analysis';
  }
  if (lower.includes('segments')) {
    return 'segments';
  }
  if (lower.includes('domain')) {
    return 'domain';
  }
  return undefined;
}

function extractSegmentsFromCurrentData(currentData?: Record<string, unknown>): SegmentContext[] {
  if (!currentData) {
    return [];
  }
  const rawSegments = currentData['segments'];
  if (!Array.isArray(rawSegments)) {
    return [];
  }
  const segments: SegmentContext[] = [];
  rawSegments.forEach((entry, idx) => {
    if (!entry || typeof entry !== 'object') {
      return;
    }
    const record = entry as Record<string, unknown>;
    const id =
      (typeof record.segmentId === 'string' && record.segmentId) ||
      (typeof record.id === 'string' && record.id) ||
      undefined;
    const name = typeof record.name === 'string' ? record.name : undefined;
    const labels = new Set<string>();
    if (name) {
      labels.add(name);
    }
    const aliasField = record['aliases'] ?? record['labels'];
    if (Array.isArray(aliasField)) {
      for (const alias of aliasField) {
        if (typeof alias === 'string' && alias.trim()) {
          labels.add(alias);
        }
      }
    }
    const valueQuestions = extractValueQuestions(record);
    if (!id && !name) {
      return;
    }
    const descriptor: SegmentContext = {
      labels: [...labels],
      index: idx + 1,
      valueQuestions,
    };
    if (id) {
      descriptor.id = id;
    }
    if (name) {
      descriptor.name = name;
    }
    segments.push(descriptor);
  });
  return segments;
}

function extractValueQuestions(segmentRecord: Record<string, unknown>): SegmentValueQuestionContext[] {
  const raw = segmentRecord['valueQuestions'];
  if (!Array.isArray(raw)) {
    return [];
  }
  const questions: SegmentValueQuestionContext[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : undefined;
    const question = typeof record.question === 'string' ? record.question : undefined;
    if (!id && !question) {
      continue;
    }
    const context: SegmentValueQuestionContext = {};
    if (id) {
      context.id = id;
    }
    if (question) {
      context.question = question;
    }
    questions.push(context);
  }
  return questions;
}

function enforceSegmentSelectorRequirements(
  change: Record<string, unknown>,
  segments?: SegmentContext[],
): void {
  if (change.intent !== 'segment_merge') {
    return;
  }
  if (hasSelectorTokens(change.selector)) {
    return;
  }
  if (!segments || segments.length === 0) {
    return;
  }
  const derived = deriveSegmentSelectors(change.feedback_text, segments);
  if (derived.length < 2) {
    return;
  }
  change.selector = derived;
}

function enforceSegmentRenameSelectorRequirements(
  change: Record<string, unknown>,
  segments?: SegmentContext[],
): void {
  if (change.intent !== 'segment_rename') {
    return;
  }
  if (hasSelectorTokens(change.selector)) {
    return;
  }
  const match = matchSegmentFromFeedback(change.feedback_text, segments);
  if (match) {
    change.selector = buildSegmentSelector(match);
    return;
  }
  if (segments && segments.length === 1) {
    const sole = segments[0];
    if (sole) {
      change.selector = buildSegmentSelector(sole);
      return;
    }
  }
  change.selector = 'segments';
  change.scopeAll = true;
}

function hasSelectorTokens(selector: unknown): boolean {
  if (Array.isArray(selector)) {
    return selector.some((token) => typeof token === 'string' && token.trim().length > 0);
  }
  return typeof selector === 'string' && selector.trim().length > 0;
}

function deriveSegmentSelectors(feedbackText: unknown, segments: SegmentContext[]): string[] {
  if (typeof feedbackText !== 'string') {
    return [];
  }
  const normalized = normalizeQuotes(feedbackText).toLowerCase();
  const selectors = new Set<string>();
  for (const segment of segments) {
    if (segmentMatchesFeedback(segment, normalized)) {
      selectors.add(buildSegmentSelector(segment));
    }
  }
  return [...selectors];
}

function segmentMatchesFeedback(segment: SegmentContext, feedback: string): boolean {
  const candidates = [
    segment.name,
    segment.id,
    ...(segment.labels ?? []),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return candidates.some((candidate) => feedback.includes(candidate.toLowerCase()));
}

function buildSegmentSelector(segment: SegmentContext): string {
  if (segment.id) {
    return `segments[segmentId=${segment.id}]`;
  }
  if (segment.name) {
    return `segments[name="${escapeSelectorValue(segment.name)}"]`;
  }
  throw new Error('Cannot build selector without segment identifier.');
}

function buildValueQuestionsSelectorFromSegmentId(segmentId: unknown): string | undefined {
  const normalized = coerceSegmentId(segmentId);
  if (!normalized) {
    return undefined;
  }
  return `segments[segmentId=${normalized}].valueQuestions`;
}

function escapeSelectorValue(value: string): string {
  return value.replace(/"/g, '\\"');
}

function normalizeQuotes(value: string): string {
  return value.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
}

function applyCurrentSegmentValueQuestionSelector(change: Record<string, unknown>): boolean {
  const selector = buildValueQuestionsSelectorFromSegmentId(change['current_segmentId']);
  if (!selector) {
    return false;
  }
  change.selector = selector;
  if (change.scopeAll) {
    change.scopeAll = false;
  }
  return true;
}

function enforceValueQuestionSelectorRequirements(
  change: Record<string, unknown>,
  segments?: SegmentContext[],
): void {
  const intents = new Set(['value_question_remove', 'value_question_edit']);
  if (!intents.has(change.intent as string)) {
    return;
  }
  if (hasSelectorTokens(change.selector)) {
    return;
  }
  const match = matchValueQuestionFromFeedback(change.feedback_text, segments);
  if (!match) {
    applyCurrentSegmentValueQuestionSelector(change);
    return;
  }
  const baseSelector = buildSegmentSelector(match.segment);
  if (match.questionId) {
    change.selector = `${baseSelector}.valueQuestions[id=${match.questionId}]`;
    if (!change.questionId) {
      change.questionId = match.questionId;
    }
  } else {
    change.selector = `${baseSelector}.valueQuestions`;
  }
}

function ensureDefaultSelectors(change: Record<string, unknown>): void {
  if (change.target === 'segments' && !hasSelectorTokens(change.selector)) {
    change.selector = 'segments';
    change.scopeAll = true;
    return;
  }
  if (change.target === 'domain') {
    change.selector = 'domain';
    change.scopeAll = true;
  }
}

function applySegmentAdditionFallback(change: Record<string, unknown>): void {
  if (change.intent !== 'analysis_edit' && change.target !== 'analysis') {
    return;
  }
  const feedback = typeof change.feedback_text === 'string' ? change.feedback_text : '';
  if (!feedback) {
    return;
  }
  if (!matchesSegmentKeyword(feedback) || !hasSegmentAdditionCue(feedback)) {
    return;
  }
  change.intent = 'segment_add';
  change.target = 'segments';
  if (!hasSelectorTokens(change.selector)) {
    change.selector = 'segments';
    change.scopeAll = true;
  }
  if (change.dimension !== undefined) {
    delete change.dimension;
  }
}

function ensureSegmentTargetFromFeedback(
  change: Record<string, unknown>,
  segments?: SegmentContext[],
): void {
  const currentTarget = normalizeTarget(change.target);
  if (currentTarget === 'segments') {
    return;
  }
  const match = matchSegmentFromFeedback(change.feedback_text, segments);
  if (!match) {
    return;
  }
  change.target = 'segments';
  if (!hasSelectorTokens(change.selector)) {
    change.selector = buildSegmentSelector(match);
  }
}

function matchValueQuestionFromFeedback(
  feedbackText: unknown,
  segments?: SegmentContext[],
): { segment: SegmentContext; questionId?: string } | undefined {
  if (!segments || segments.length === 0) {
    return undefined;
  }
  if (typeof feedbackText !== 'string' || !feedbackText.trim()) {
    return undefined;
  }
  const normalized = normalizeQuotes(feedbackText).toLowerCase();
  for (const segment of segments) {
    const questions = segment.valueQuestions ?? [];
    for (const question of questions) {
      if (!question.question && !question.id) {
        continue;
      }
      const normalizedQuestion = question.question
        ? normalizeQuotes(question.question).toLowerCase()
        : undefined;
      const normalizedId = question.id ? question.id.toLowerCase() : undefined;
      const matchesQuestion =
        normalizedQuestion && normalizedQuestion.length > 0 && normalized.includes(normalizedQuestion);
      const matchesId = normalizedId && normalized.includes(normalizedId);
      if (matchesQuestion || matchesId) {
        const result: { segment: SegmentContext; questionId?: string } = { segment };
        if (question.id) {
          result.questionId = question.id;
        }
        return result;
      }
    }
  }
  return undefined;
}

function enforceValueQuestionAddSelectorRequirements(
  change: Record<string, unknown>,
  segments?: SegmentContext[],
): void {
  if (change.intent !== 'value_question_add') {
    return;
  }
  if (hasSelectorTokens(change.selector)) {
    return;
  }
  const match = matchSegmentFromFeedback(change.feedback_text, segments);
  if (match) {
    change.selector = `${buildSegmentSelector(match)}.valueQuestions`;
    return;
  }
  if (segments && segments.length === 1) {
    const sole = segments[0];
    if (sole) {
      change.selector = `${buildSegmentSelector(sole)}.valueQuestions`;
      return;
    }
    return;
  }
  if (applyCurrentSegmentValueQuestionSelector(change)) {
    return;
  }
  change.selector = 'segments';
  change.scopeAll = true;
}

function enforceAnalysisSelectorRequirements(
  change: Record<string, unknown>,
  segments?: SegmentContext[],
): void {
  const targetsAnalysis = change.intent === 'analysis_edit' || change.target === 'analysis';
  if (!targetsAnalysis) {
    return;
  }
  if (hasSelectorTokens(change.selector)) {
    return;
  }
  const match = matchSegmentFromFeedback(change.feedback_text, segments);
  if (!match) {
    change.selector = 'segments';
    change.scopeAll = true;
    return;
  }
  const baseSelector = buildSegmentSelector(match);
  change.selector = appendAnalysisDimension(baseSelector, change.dimension);
}

function propagateSegmentContext(changes: unknown[]): void {
  let lastSegmentSelector: string | undefined;
  for (const change of changes) {
    if (!change || typeof change !== 'object') {
      continue;
    }
    const record = change as Record<string, unknown>;
    const selectorToken = extractSegmentSelectorToken(record.selector);
    if (selectorToken) {
      lastSegmentSelector = selectorToken;
      continue;
    }
    const target = normalizeTarget(record.target);
    if (!targetRequiresSegmentContext(target)) {
      continue;
    }
    if (!lastSegmentSelector || hasSelectorTokens(record.selector)) {
      continue;
    }
    applySegmentSelector(record, lastSegmentSelector, target);
  }
}

function extractSegmentSelectorToken(selector: unknown): string | undefined {
  if (!selector) {
    return undefined;
  }
  const tokens = Array.isArray(selector) ? selector : [selector];
  for (const token of tokens) {
    if (typeof token !== 'string') {
      continue;
    }
    const trimmed = token.trim();
    if (!trimmed) {
      continue;
    }
    const bracketMatch = trimmed.match(/segments\[[^\]]+\]/i);
    if (bracketMatch) {
      return bracketMatch[0];
    }
    const idMatch = trimmed.match(/\bseg_[\w-]+\b/i);
    if (idMatch) {
      return `segments[segmentId=${idMatch[0]}]`;
    }
  }
  return undefined;
}

function applySegmentSelector(
  change: Record<string, unknown>,
  baseSelector: string,
  target: AllowedTarget | undefined,
): void {
  switch (target) {
    case 'analysis':
      change.selector = appendAnalysisDimension(baseSelector, change.dimension);
      break;
    case 'valueQuestions':
      change.selector = `${baseSelector}.valueQuestions`;
      break;
    default:
      change.selector = baseSelector;
  }
  if (change.scopeAll) {
    change.scopeAll = false;
  }
  const extractedId = extractSegmentIdFromSelector(baseSelector);
  if (extractedId) {
    change['current_segmentId'] = extractedId;
  }
}

function targetRequiresSegmentContext(target: AllowedTarget | undefined): boolean {
  return target === 'segments' || target === 'analysis' || target === 'valueQuestions';
}

function extractSegmentIdFromSelector(selector: string): string | undefined {
  const match = selector.match(/segmentId=([^]\s]+)]/i);
  if (match && match[1]) {
    return stripQuotes(match[1]);
  }
  return undefined;
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]/, '').replace(/['"]$/, '');
}

function ensureAllowedTargetValue(
  target: unknown,
  selector: unknown,
  feedbackText: unknown,
): AllowedTarget {
  const normalized = normalizeTarget(target);
  if (normalized) {
    return normalized;
  }
  const inferredFromSelector = inferTargetFromSelector(selector);
  if (inferredFromSelector) {
    return inferredFromSelector;
  }
  const inferredFromKeywords = inferTargetFromKeywords(feedbackText, selector);
  if (inferredFromKeywords) {
    return inferredFromKeywords;
  }
  return 'segments';
}

function ensureCanonicalIntentValue(
  intent: unknown,
  target: AllowedTarget,
  feedbackText: unknown,
): FeedbackIntent {
  const canonical = canonicalizeIntent(intent, target);
  if (canonical) {
    return canonical;
  }
  const inferred = inferIntentFromFeedback(feedbackText, target);
  if (inferred) {
    return inferred;
  }
  const fallback = fallbackIntentForTarget(target);
  const payload: FallbackLogPayload = {
    fallback,
    target,
    rawIntent: intent,
  };
  if (typeof feedbackText === 'string' && feedbackText.trim().length > 0) {
    payload.feedbackText = feedbackText;
  }
  logFallbackIntent(payload);
  return fallback;
}

function matchSegmentFromFeedback(
  feedbackText: unknown,
  segments?: SegmentContext[],
): SegmentContext | undefined {
  if (!segments || segments.length === 0) {
    return undefined;
  }
  if (segments.length === 1) {
    return segments[0];
  }
  if (typeof feedbackText !== 'string' || !feedbackText.trim()) {
    return undefined;
  }
  const normalized = normalizeQuotes(feedbackText).toLowerCase();
  for (const segment of segments) {
    const tokens = [
      segment.id,
      segment.name,
      ...(segment.labels ?? []),
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    for (const token of tokens) {
      if (normalized.includes(token.toLowerCase())) {
        return segment;
      }
    }
  }
  const indexMatch = extractSegmentIndex(normalized);
  if (indexMatch !== undefined) {
    return segments.find((seg) => seg.index === indexMatch);
  }
  return undefined;
}

function extractSegmentIndex(text: string): number | undefined {
  const match = text.match(/segment\s*(\d+)/i);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  return Number.isNaN(value) ? undefined : value;
}

function appendAnalysisDimension(baseSelector: string, dimension: unknown): string {
  if (typeof dimension === 'string' && dimension.trim().length > 0) {
    return `${baseSelector}.analysis.${dimension}`;
  }
  if (baseSelector.endsWith('.analysis')) {
    return baseSelector;
  }
  return `${baseSelector}.analysis`;
}

function enforceValueQuestionIntentHeuristics(change: Record<string, unknown>): void {
  const feedback = typeof change.feedback_text === 'string' ? change.feedback_text.toLowerCase() : '';
  if (!feedback || !feedback.includes('question')) {
    return;
  }
  const addCue = /\b(add|create|insert|new)\b/.test(feedback);
  const removeCue = /\b(remove|delete|drop|eliminate|get rid of)\b/.test(feedback);
  const editCue = /\b(edit|change|update|modify|reword|rephrase)\b/.test(feedback);

  if (addCue) {
    change.intent = 'value_question_add';
    change.target = 'valueQuestions';
    return;
  }
  if (removeCue) {
    change.intent = 'value_question_remove';
    change.target = 'valueQuestions';
    return;
  }
  if (editCue) {
    change.intent = 'value_question_edit';
    change.target = 'valueQuestions';
  }
}

export const __TESTING__ = {
  normalizeInterpreterResponse,
};
