import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { z } from 'zod';

import config from './config';
import {
  buildRouterPlan,
  demoSegments,
  InMemoryScopeResolver,
  Policy,
  RouterError,
  type FeedbackChange,
  type ScopeResolver,
  type AnalysisDimension,
} from './index';
import { sendDifyChatMessage, type DifyResponseMode } from './dify/chatClient';
import { interpretFeedback } from './interpreter/openaiInterpreter';
import type { SegmentDescriptor } from './resolvers/scopeResolver';

const fastify = Fastify({
  logger: true,
});

fastify.register(cors, {
  origin: ['http://localhost:3000', '*'],
  methods: ['GET', 'POST', 'OPTIONS'],
});

const defaultScopeResolver = new InMemoryScopeResolver(demoSegments);

const changeSchema = z.object({
  intent: z.union([
    z.literal('domain_correction'),
    z.literal('segment_rescore'),
    z.literal('segment_edit'),
    z.literal('segment_add'),
    z.literal('segment_remove'),
    z.literal('segment_rename'),
    z.literal('segment_merge'),
    z.literal('analysis_recore'),
    z.literal('analysis_edit'),
    z.literal('analysis_rename'),
    z.literal('value_question_rescore'),
    z.literal('value_question_edit'),
    z.literal('value_question_add'),
    z.literal('value_question_remove'),
  ]),
  target: z.union([z.literal('domain'), z.literal('segments'), z.literal('analysis'), z.literal('valueQuestions')]),
  selector: z.union([z.string(), z.array(z.string())]).optional(),
  dimension: z.enum(['D1', 'D2', 'D3', 'D4']).optional(),
  questionId: z.string().optional(),
  delta: z.number().optional(),
  scopeAll: z.boolean().optional(),
  confidence: z.number().min(0).max(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
  feedback_text: z.string().optional(),
  current_segmentId: z.string().optional(),
});

const previewSchema = z.object({
  base_run_id: z.string(),
  policy: z.union([z.literal('conservative'), z.literal('standard'), z.literal('aggressive')]).optional(),
  changes: z.array(changeSchema).min(1),
});

const interpretSchema = z.object({
  feedback_text: z.string().min(1),
  base_run_id: z.string().optional(),
  current_data: z.record(z.string(), z.unknown()).optional(),
  current_segmentId: z.string().optional(),
});

const autoPlanSchema = z.object({
  feedback_text: z.string().min(1),
  base_run_id: z.string(),
  user_id: z.string().optional(),
  task_id: z.string().optional(),
  policy: z.union([z.literal('conservative'), z.literal('standard'), z.literal('aggressive')]).optional(),
  current_data: z.record(z.string(), z.unknown()).optional(),
  current_segmentId: z.string().optional(),
});

const difyResponseModeSchema = z.enum(['streaming', 'blocking']);

const analysisDimensionSchema = z
  .object({
    score: z.number().optional(),
    summary: z.string().optional(),
    supporting_indicators: z.array(z.string()).optional(),
    user_persona: z
      .object({
        role: z.string().optional(),
        pain_points: z.array(z.string()).optional(),
        company_type: z.string().optional(),
      })
      .optional(),
    revenue_band: z.string().optional(),
    retention_signal: z.string().optional(),
    conversion_rate_est: z.number().optional(),
    moat_score: z.number().optional(),
    scalability_score: z.number().optional(),
    competitive_advantage: z.array(z.string()).optional(),
  })
  .passthrough();

const analysisSchema = z
  .object({
    D1: analysisDimensionSchema.optional(),
    D2: analysisDimensionSchema.optional(),
    D3: analysisDimensionSchema.optional(),
    D4: analysisDimensionSchema.optional(),
  })
  .passthrough();

const valueQuestionSchema = z
  .object({
    id: z.string().optional(),
    sql: z.string().optional(),
    intent: z.string().optional(),
    question: z.string().optional(),
    rationale: z.string().optional(),
    answerShape: z.enum(['comparison', 'trend', 'distribution', 'optimization', 'correlation']).optional(),
  })
  .passthrough();

const segmentSchema = z
  .object({
    name: z.string().optional(),
    segmentId: z.string().optional(),
    segment_id: z.string().optional(),
    segment_type: z.enum(['B2B', 'B2C', 'Other']).optional(),
    scope: z
      .object({
        size: z.string().optional(),
        region: z.string().optional(),
        industry: z.string().optional(),
      })
      .passthrough()
      .optional(),
    analysis: analysisSchema.optional(),
    valueQuestions: z.array(valueQuestionSchema).optional(),
    confidence: z.number().optional(),
    justification: z.array(z.string()).optional(),
  })
  .passthrough();

const anchIndexSchema = z
  .object({
    index: z.number().int().optional(),
    table: z.string().optional(),
    columns: z.array(z.string()).optional(),
  })
  .passthrough();

const currentDataSchema = z
  .object({
    domain: z
      .object({
        primaryDomain: z.string().optional(),
      })
      .passthrough(),
    ingest: z
      .object({
        schemaHash: z.string().optional(),
      })
      .passthrough()
      .optional(),
    run_id: z.string().optional(),
    status: z.enum(['pending', 'running', 'complete', 'failed']).optional(),
    task_id: z.string().optional(),
    segments: z.array(segmentSchema),
    anchIndex: z.array(anchIndexSchema).optional(),
    parent_run_id: z.union([z.string(), z.null()]).optional(),
  })
  .passthrough();

const intentionSchema = z.object({
  feedback_text: z.string().min(1),
  base_run_id: z.string(),
  policy: z.enum(['standard', 'strict', 'lenient']).optional(),
  user_id: z.string().uuid(),
  task_id: z.string(),
  connection_id: z.string().optional(),
  current_data: currentDataSchema,
});

fastify.get('/health', async () => ({ status: 'ok' }));

fastify.post('/api/v1/feedback-mrf/interpret', async (request, reply) => {
  const { feedback_text, base_run_id, current_data, current_segmentId } = interpretSchema.parse(request.body ?? {});
  try {
    const interpretInput = {
      feedbackText: feedback_text,
      ...(base_run_id ? { baseRunId: base_run_id } : {}),
      ...(current_data ? { current_data } : {}),
      ...(current_segmentId ? { currentSegmentId: current_segmentId } : {}),
    };
    const result = await interpretFeedback(interpretInput);
    const changesWithFeedback = attachFeedbackText(result.changes, feedback_text);
    const confidentChanges = ensureConfidence(changesWithFeedback);
    const domainAwareChanges = ensureDomainSelectors(confidentChanges);
    const normalizedChanges = applyDimensionHints(domainAwareChanges);
    const { changes: ensuredChanges, guidanceSignals } = ensureChanges(normalizedChanges, feedback_text, current_data);
    const guidance = buildGuidanceMessages(guidanceSignals, ensuredChanges);

    return {
      model: config.interpreter.model,
      threshold: config.interpreter.confidenceThreshold,
      changeset: formatChangesetResponse(ensuredChanges),
      reasoning: result.reasoning,
      guidance,
    };
  } catch (error) {
    request.log.error(error);
    reply.status(502);
    return {
      error: 'INTERPRETER_FAILED',
      message: error instanceof Error ? error.message : 'Interpreter failed',
    };
  }
});

fastify.post('/api/v1/feedback-mrf/preview', async (request, reply) => {
  const { base_run_id, policy, changes } = previewSchema.parse(request.body ?? {});

  try {
    const plan = computePlan(base_run_id, policy, changes as FeedbackChange[]);
    return { plan };
  } catch (error) {
    if (error instanceof RouterError) {
      const status = mapErrorToStatus(error.code);
      reply.status(status);
      return {
        error: error.code,
        message: error.message,
      };
    }
    throw error;
  }
});

fastify.post('/api/v1/feedback-mrf/plan', async (request, reply) => {
  const { feedback_text, base_run_id, policy, current_data, user_id, task_id, current_segmentId } = autoPlanSchema.parse(
    request.body ?? {},
  );

  try {
    const interpretation = await interpretFeedback({
      feedbackText: feedback_text,
      baseRunId: base_run_id,
      ...(current_data ? { current_data } : {}),
      ...(current_segmentId ? { currentSegmentId: current_segmentId } : {}),
    });
    const changesWithFeedback = attachFeedbackText(interpretation.changes, feedback_text);
    const confidentChanges = ensureConfidence(changesWithFeedback);
    const domainAwareChanges = ensureDomainSelectors(confidentChanges);
    const normalizedChanges = applyDimensionHints(domainAwareChanges);
    const { changes: ensuredChanges, guidanceSignals } = ensureChanges(
      normalizedChanges,
      feedback_text,
      current_data,
    );
    const guidance = buildGuidanceMessages(guidanceSignals, ensuredChanges);

    const plan = computePlan(base_run_id, policy, ensuredChanges, resolveScopeResolver(current_data));

    return {
      base_run_id,
      ...(user_id ? { user_id } : {}),
      ...(task_id ? { task_id } : {}),
      model: config.interpreter.model,
      changeset: formatChangesetResponse(ensuredChanges),
      plan,
      reasoning: interpretation.reasoning,
      guidance,
    };
  } catch (error) {
    if (error instanceof RouterError) {
      const status = mapErrorToStatus(error.code);
      reply.status(status);
      return {
        error: error.code,
        message: error.message,
      };
    }

    request.log.error(error);
    reply.status(502);
    return {
      error: 'INTERPRETER_OR_ROUTER_FAILED',
      message: error instanceof Error ? error.message : 'Interpreter or router failed',
    };
  }
});

fastify.post('/api/v1/feedback-mrf/intention', async (request, reply) => {
  const payload = intentionSchema.parse(request.body ?? {});
  try {
    const inputs: Record<string, unknown> = {
      run_results: JSON.stringify(payload.current_data),
    };
    if (payload.base_run_id) {
      inputs.base_run_id = payload.base_run_id;
    }
    if (payload.policy) {
      inputs.policy = payload.policy;
    }
    if (payload.user_id) {
      inputs.user_id = payload.user_id;
    }
    if (payload.task_id) {
      inputs.task_id = payload.task_id;
    }
    if (payload.connection_id) {
      inputs.connection_id = payload.connection_id;
    }

    const { response, mode } = await sendDifyChatMessage({
      query: payload.feedback_text,
      inputs,
      user: payload.user_id,
      response_mode: 'blocking',
    });

    if (!response.ok) {
      const errorText = await response.text();
      request.log.error(
        {
          status: response.status,
          body: errorText,
        },
        'Dify request failed',
      );
      reply.status(response.status);
      return {
        error: 'DIFY_ERROR',
        message: errorText || 'Dify request failed',
      };
    }

    const data = await readDifyResponseBody(response, mode);
    request.log.info({ dify_response: data }, 'Received response from Dify');

    const changesArray = extractDifyChanges(data);
    const changeset = mapChangeset(changesArray, payload.feedback_text);
    if (!changeset.length) {
      request.log.error(
        {
          data,
        },
        'Dify response did not contain a valid changeset',
      );
      reply.status(502);
      return {
        error: 'DIFY_INVALID_RESPONSE',
        message: 'Dify response did not include a valid changeset.',
      };
    }

    const model = extractDifyModel(data) ?? 'dify';

    return {
      base_run_id: payload.base_run_id,
      user_id: payload.user_id,
      task_id: payload.task_id,
      model,
      changeset,
    };
  } catch (error) {
    request.log.error(error);
    reply.status(502);
    return {
      error: 'DIFY_REQUEST_FAILED',
      message: error instanceof Error ? error.message : 'Dify request failed',
    };
  }
});

type ChangesetIntent = 'segment_edit' | 'add' | 'edit' | 'remove' | 'merge' | 'rescore' | 'scope_change';

interface ChangesetEntry {
  intent: ChangesetIntent;
  target: string;
  selector: string;
  confidence: number;
  prompt: string;
}

const allowedChangesetIntents: ChangesetIntent[] = [
  'segment_edit',
  'add',
  'edit',
  'remove',
  'merge',
  'rescore',
  'scope_change',
];

async function readDifyResponseBody(response: Response, mode: DifyResponseMode): Promise<unknown> {
  if (mode === 'streaming') {
    if (!response.body) {
      throw new Error('Streaming response missing body.');
    }
    const raw = await readWebStreamToString(response.body as WebReadableStream<Uint8Array>);
    const events = parseSsePayload(raw);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const candidate = events[index];
      if (candidate !== undefined) {
        return candidate;
      }
    }
    return {};
  }

  const rawText = await response.text();
  if (!rawText) {
    return {};
  }
  try {
    return JSON.parse(rawText);
  } catch {
    return { raw: rawText };
  }
}

function parseSsePayload(payload: string): unknown[] {
  if (!payload) {
    return [];
  }
  const lines = payload.split(/\r?\n/);
  const entries: unknown[] = [];
  for (const line of lines) {
    if (!line.startsWith('data:')) {
      continue;
    }
    const content = line.slice(5).trim();
    if (!content || content === '[DONE]') {
      continue;
    }
    try {
      entries.push(JSON.parse(content));
    } catch {
      entries.push({ raw: content });
    }
  }
  return entries;
}

async function readWebStreamToString(stream: WebReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      result += decoder.decode(value, { stream: true });
    }
  }
  result += decoder.decode();
  return result;
}

function extractDifyChanges(payload: unknown): unknown[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const record = payload as Record<string, unknown>;
  const direct = record['changeset'];
  if (Array.isArray(direct)) {
    return direct;
  }

  const answerDerived = extractChangesFromAnswer(record['answer']);
  if (answerDerived.length > 0) {
    return answerDerived;
  }

  const data = record['data'];
  if (Array.isArray(data)) {
    return data;
  }
  if (data && typeof data === 'object') {
    const candidate =
      (data as Record<string, unknown>)['changeset'] ?? (data as Record<string, unknown>)['changes'];
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  const outputs = record['outputs'];
  if (outputs && typeof outputs === 'object') {
    const candidate =
      (outputs as Record<string, unknown>)['changeset'] ?? (outputs as Record<string, unknown>)['changes'];
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  const result = record['result'];
  if (Array.isArray(result)) {
    return result;
  }

  return [];
}

function extractChangesFromAnswer(answer: unknown): unknown[] {
  if (typeof answer === 'string') {
    const parsed = parseJsonLikeString(answer);
    return extractChangesFromParsedObject(parsed);
  }
  if (answer && typeof answer === 'object') {
    const record = answer as Record<string, unknown>;
    const fromObject = extractChangesFromParsedObject(record);
    if (fromObject.length > 0) {
      return fromObject;
    }
    const textField = record['text'];
    if (typeof textField === 'string') {
      const parsed = parseJsonLikeString(textField);
      return extractChangesFromParsedObject(parsed);
    }
  }
  return [];
}

function parseJsonLikeString(input: string): unknown {
  let trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith('```')) {
    const lines = trimmed.split(/\r?\n/);
    if (lines.length > 0) {
      lines.shift();
    }
    if (lines.length > 0 && lines[lines.length - 1]?.startsWith('```')) {
      lines.pop();
    }
    trimmed = lines.join('\n').trim();
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    const candidate = trimmed.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // Fallback below
    }
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function extractChangesFromParsedObject(parsed: unknown): unknown[] {
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }
  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record['changeset'])) {
    return record['changeset'] as unknown[];
  }
  if (Array.isArray(record['changes'])) {
    return record['changes'] as unknown[];
  }
  return [];
}

function mapChangeset(rawChanges: unknown[], defaultPrompt: string): ChangesetEntry[] {
  const entries: ChangesetEntry[] = [];
  for (const change of rawChanges) {
    if (!change || typeof change !== 'object') {
      continue;
    }
    const record = change as Record<string, unknown>;
    const target = coerceStringLoose(record.target);
    const selector = coerceSelector(record.selector);
    if (!target || !selector) {
      continue;
    }
    const intent = mapChangesetIntent(record.intent);
    const confidence = coerceConfidence(record.confidence);
    const prompt = coerceStringLoose(record.prompt) ?? defaultPrompt;

    entries.push({
      intent,
      target,
      selector,
      confidence,
      prompt,
    });
  }
  return entries;
}

function extractDifyModel(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const direct = coerceStringLoose(record.model);
  if (direct) {
    return direct;
  }
  const data = record['data'];
  if (data && typeof data === 'object') {
    const fromData = coerceStringLoose((data as Record<string, unknown>).model);
    if (fromData) {
      return fromData;
    }
  }
  const meta = record['meta'];
  if (meta && typeof meta === 'object') {
    const fromMeta = coerceStringLoose((meta as Record<string, unknown>).model);
    if (fromMeta) {
      return fromMeta;
    }
  }
  return undefined;
}

function mapChangesetIntent(intent: unknown): ChangesetIntent {
  const value = coerceStringLoose(intent)?.toLowerCase();
  if (!value) {
    return 'edit';
  }
  if ((allowedChangesetIntents as readonly string[]).includes(value)) {
    return value as ChangesetIntent;
  }
  switch (value) {
    case 'segment_add':
    case 'add_segment':
      return 'add';
    case 'segment_remove':
    case 'remove_segment':
    case 'delete':
      return 'remove';
    case 'segment_merge':
    case 'merge_segment':
      return 'merge';
    case 'segment_rescore':
    case 'analysis_rescore':
    case 'analysis_recore':
    case 'rescore_segments':
      return 'rescore';
    case 'segment_edit':
      return 'segment_edit';
    case 'scope':
    case 'scopechange':
    case 'scope-change':
      return 'scope_change';
    default:
      return 'edit';
  }
}

function coerceConfidence(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function coerceSelector(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const normalized = coerceStringLoose(value);
    if (normalized) {
      return normalized;
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return undefined;
    }
    if (value.every((item) => typeof item === 'string')) {
      return value.join(', ');
    }
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function coerceStringLoose(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toString();
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return undefined;
}

function mapErrorToStatus(code: RouterError['code']): number {
  switch (code) {
    case 'LOW_CONFIDENCE':
    case 'EMPTY_SCOPE':
    case 'SEGMENT_NOT_FOUND':
    case 'SEGMENT_NOT_UNIQUE':
      return 422;
    case 'CONFLICTING_COMMANDS':
    case 'SCHEMA_CHANGED':
      return 409;
    case 'BASELINE_NOT_FOUND':
      return 404;
    default:
      return 400;
  }
}

function validateBaseline(runId: string): boolean {
  if (config.baseline.allowMissing) {
    return true;
  }
  return runId.startsWith('r_');
}

function computePlan(
  baseRunId: string,
  policy: Policy | undefined,
  changes: FeedbackChange[],
  scopeResolverOverride?: ScopeResolver,
) {
  const resolver = scopeResolverOverride ?? defaultScopeResolver;
  return buildRouterPlan(
    {
      baseRunId,
      policy: (policy ?? config.policy.default) as Policy,
      changes,
    },
    {
      scopeResolver: resolver,
      baselineValidator: validateBaseline,
    },
  );
}

function resolveScopeResolver(currentData?: Record<string, unknown>): ScopeResolver {
  const dynamicSegments = extractSegmentsFromCurrentData(currentData);
  if (!dynamicSegments.length) {
    return defaultScopeResolver;
  }
  return new InMemoryScopeResolver(dynamicSegments);
}

function attachFeedbackText(changes: FeedbackChange[], feedbackText?: string): FeedbackChange[] {
  if (!feedbackText) {
    return changes;
  }
  return changes.map((change) =>
    typeof change.feedback_text === 'string' && change.feedback_text.trim().length > 0
      ? change
      : { ...change, feedback_text: feedbackText },
  );
}

function ensureConfidence(changes: FeedbackChange[]): FeedbackChange[] {
  return changes.map((change) => {
    if (typeof change.confidence === 'number') {
      return change;
    }
    return {
      ...change,
      confidence: config.interpreter.confidenceThreshold ?? 0.8,
    };
  });
}

function ensureDomainSelectors(changes: FeedbackChange[]): FeedbackChange[] {
  return changes.map((change) => {
    if (change.target === 'domain' && !change.selector) {
      return {
        ...change,
        selector: 'domain',
      };
    }
    return change;
  });
}

function applyDimensionHints(changes: FeedbackChange[]): FeedbackChange[] {
  return changes.map((change) => {
    if (change.target !== 'analysis') {
      return change;
    }
    const hint = detectDimensionHint(change.feedback_text);
    if (!hint) {
      return change;
    }

    if (!change.selector) {
      return {
        ...change,
        dimension: hint,
      };
    }

    const selector = applyDimensionToSelector(change.selector, hint);
    const next: FeedbackChange = {
      ...change,
      dimension: hint,
    };
    next.selector = selector;
    return next;
  });
}

const dimensionHints: Array<{ pattern: RegExp; dimension: AnalysisDimension }> = [
  { pattern: /market\s+opportunity/i, dimension: 'D1' },
  { pattern: /customer\s+persona/i, dimension: 'D2' },
  { pattern: /competitive\s+advantage/i, dimension: 'D3' },
  { pattern: /revenue\s+potential/i, dimension: 'D4' },
];

function detectDimensionHint(text?: string): AnalysisDimension | undefined {
  if (!text) {
    return undefined;
  }
  for (const hint of dimensionHints) {
    if (hint.pattern.test(text)) {
      return hint.dimension;
    }
  }
  return undefined;
}

function applyDimensionToSelector(selector: string | string[], dimension: AnalysisDimension): string | string[] {
  if (Array.isArray(selector)) {
    return selector.map((token) => rewriteSelectorToken(token, dimension));
  }
  return rewriteSelectorToken(selector, dimension);
}

function rewriteSelectorToken(token: string, dimension: AnalysisDimension): string {
  if (token.includes('.analysis')) {
    if (/\.analysis\.d[1-4]/i.test(token)) {
      return token.replace(/(\.analysis\.)d[1-4]/i, `$1${dimension}`);
    }
    if (/\.analysis$/i.test(token)) {
      return `${token}.${dimension}`;
    }
  }
  return token;
}

type GuidanceSignal = 'fallback_inferred_change' | 'ambiguous_segment_scope';

function ensureChanges(
  changes: FeedbackChange[],
  feedbackText: string,
  currentData?: Record<string, unknown>,
): { changes: FeedbackChange[]; guidanceSignals: GuidanceSignal[] } {
  const signals: GuidanceSignal[] = [];
  if (changes.length === 0) {
    const segmentRemoval = deriveSegmentRemoval(feedbackText, currentData);
    if (segmentRemoval) {
      changes = [segmentRemoval];
      signals.push('fallback_inferred_change');
    } else {
      const domainChange = deriveDomainChange(feedbackText);
      if (domainChange) {
        changes = [domainChange];
        signals.push('fallback_inferred_change');
      } else {
        const valueQuestionChange = deriveValueQuestionRemoval(feedbackText, currentData);
        if (valueQuestionChange) {
          changes = [valueQuestionChange];
          signals.push('fallback_inferred_change');
        } else {
          const derived = deriveAnalysisChange(feedbackText, currentData);
          if (derived) {
            changes = [derived];
            signals.push('fallback_inferred_change');
          }
        }
      }
    }
  }

  const scopeSignals = collectScopeSignals(changes);
  return { changes, guidanceSignals: [...new Set([...signals, ...scopeSignals])] };
}

function deriveAnalysisChange(
  feedbackText: string,
  currentData?: Record<string, unknown>,
): FeedbackChange | undefined {
  if (!feedbackText?.trim()) {
    return undefined;
  }

  const dimension = detectDimensionHint(feedbackText);
  if (!dimension) {
    return undefined;
  }

  const segments = extractSegmentsFromCurrentData(currentData);
  const matchingSegment = matchSegmentByFeedback(feedbackText, segments);
  if (!matchingSegment) {
    return undefined;
  }

  return {
    intent: 'analysis_edit',
    target: 'analysis',
    selector: `segments[segmentId=${matchingSegment.id}].analysis.${dimension}`,
    dimension,
    confidence: Math.max(config.interpreter.confidenceThreshold ?? 0.7, 0.8),
    feedback_text: feedbackText,
  };
}

function matchSegmentByFeedback(text: string, segments: SegmentDescriptor[]): SegmentDescriptor | undefined {
  if (!segments.length) {
    return undefined;
  }
  const lower = text.toLowerCase();
  for (const segment of segments) {
    if (lower.includes(segment.id.toLowerCase())) {
      return segment;
    }
    for (const label of segment.labels) {
      if (lower.includes(label.toLowerCase())) {
        return segment;
      }
    }
  }
  return undefined;
}

function deriveValueQuestionRemoval(
  feedbackText: string,
  currentData?: Record<string, unknown>,
): FeedbackChange | undefined {
  if (!feedbackText?.trim() || !currentData) {
    return undefined;
  }

  const lowered = feedbackText.toLowerCase();
  const normalizedFeedback = lowered.replace(/[‘’]/g, "'");
  if (!/(delete|remove)/i.test(feedbackText) || !normalizedFeedback.includes('value question')) {
    return undefined;
  }

  const segments = Array.isArray(currentData['segments']) ? currentData['segments'] : [];
  for (const rawSegment of segments) {
    if (!rawSegment || typeof rawSegment !== 'object') {
      continue;
    }

    const segmentRecord = rawSegment as Record<string, unknown>;
    const segmentId = coerceString(segmentRecord['segmentId']) ?? coerceString(segmentRecord['id']);
    if (!segmentId) {
      continue;
    }

    const valueQuestions = Array.isArray(segmentRecord['valueQuestions']) ? segmentRecord['valueQuestions'] : [];
    for (const rawQuestion of valueQuestions) {
      if (!rawQuestion || typeof rawQuestion !== 'object') {
        continue;
      }
      const questionRecord = rawQuestion as Record<string, unknown>;
      const questionText = coerceString(questionRecord['question']);
      if (!questionText) {
        continue;
      }
      const normalizedQuestion = questionText.replace(/[‘’]/g, "'").toLowerCase();
      if (normalizedFeedback.includes(normalizedQuestion)) {
        const questionId = coerceString(questionRecord['id']);
        const change: FeedbackChange = {
          intent: 'value_question_remove',
          target: 'valueQuestions',
          selector: `segments[segmentId=${segmentId}].valueQuestions`,
          confidence: Math.max(config.interpreter.confidenceThreshold ?? 0.7, 0.8),
          feedback_text: feedbackText,
        };
        if (questionId) {
          change.questionId = questionId;
        }
        return change;
      }
    }
  }

  return undefined;
}

function deriveSegmentRemoval(
  feedbackText: string,
  currentData?: Record<string, unknown>,
): FeedbackChange | undefined {
  if (!feedbackText?.trim() || !currentData) {
    return undefined;
  }

  const lowered = feedbackText.toLowerCase();
  if (!/(delete|remove|drop|kill|discard)/i.test(lowered) || !lowered.includes('segments')) {
    return undefined;
  }

  const segments = extractSegmentsFromCurrentData(currentData);
  const matchingSegment = matchSegmentByFeedback(feedbackText, segments);
  if (!matchingSegment) {
    return undefined;
  }

  return {
    intent: 'segment_remove',
    target: 'segments',
    selector: `segments[segmentId=${matchingSegment.id}]`,
    confidence: Math.max(config.interpreter.confidenceThreshold ?? 0.7, 0.8),
    feedback_text: feedbackText,
  };
}

function deriveDomainChange(feedbackText: string): FeedbackChange | undefined {
  if (!feedbackText?.trim()) {
    return undefined;
  }
  if (!/\bdomain\b/i.test(feedbackText)) {
    return undefined;
  }
  return {
    intent: 'domain_correction',
    target: 'domain',
    selector: 'domain',
    confidence: Math.max(config.interpreter.confidenceThreshold ?? 0.7, 0.8),
    feedback_text: feedbackText,
  };
}

function collectScopeSignals(changes: FeedbackChange[]): GuidanceSignal[] {
  const signals = new Set<GuidanceSignal>();
  for (const change of changes) {
    if (
      change.target === 'segments' &&
      (change.scopeAll || isGenericSegmentSelector(change.selector))
    ) {
      signals.add('ambiguous_segment_scope');
    }
  }
  return [...signals];
}

function isGenericSegmentSelector(selector: string | string[] | undefined): boolean {
  if (!selector) {
    return true;
  }
  if (Array.isArray(selector)) {
    return selector.length === 0 || selector.every((token) => token === 'segments');
  }
  const lowered = selector.toLowerCase();
  return lowered === 'segments' || lowered === 'segments';
}

function buildGuidanceMessages(
  signals: GuidanceSignal[],
  changes: FeedbackChange[],
): string[] | undefined {
  if (!signals.length) {
    return undefined;
  }
  const unique = [...new Set(signals)];
  const messages: string[] = [];
  if (unique.includes('fallback_inferred_change')) {
    messages.push(buildFallbackMessage(changes[0]));
  }
  if (unique.includes('ambiguous_segment_scope')) {
    messages.push(
      '还有一点想确认🙂：当前这条指令会影响所有细分，因为我们只能把选择器设置为“segments”。如果你只想操作某个细分，请直接写出它的名字，例如“只保留 Large Short-term Rental Platforms 这一细分”。',
    );
  }
  return messages.length ? messages : undefined;
}

function buildFallbackMessage(change?: FeedbackChange): string {
  const summary = summarizeChange(change);
  return `我们刚才凭经验推断了一下😅：模型没能直接读懂这条反馈，所以暂时把它当成“${summary}”。如果这不符合你的真实意图，请明确写出要增删改的对象和动作，我们会立刻跟进。`;
}

function summarizeChange(change?: FeedbackChange): string {
  if (!change) {
    return '一个临时操作';
  }
  const intent = change.intent.replace(/_/g, ' ');
  const selector = formatSelectorForSummary(change.selector);
  if (change.target === 'analysis' && change.dimension) {
    return `${intent} → ${selector}.${change.dimension}`;
  }
  return `${intent} → ${selector}`;
}

function formatSelectorForSummary(selector: string | string[] | undefined): string {
  if (!selector) {
    return '未指定范围';
  }
  if (Array.isArray(selector)) {
    return selector.length ? selector.join(', ') : '未指定范围';
  }
  return selector;
}

function extractSegmentsFromCurrentData(currentData?: Record<string, unknown>): SegmentDescriptor[] {
  if (!currentData) {
    return [];
  }

  const rawSegments = currentData['segments'];
  if (!Array.isArray(rawSegments)) {
    return [];
  }

  const descriptors: SegmentDescriptor[] = [];

  for (const raw of rawSegments) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }

    const candidate = raw as Record<string, unknown>;
    const id = coerceString(candidate['segmentId']) ?? coerceString(candidate['id']);
    if (!id) {
      continue;
    }

    const labelSet = new Set<string>();
    const name = coerceString(candidate['name']);
    if (name) {
      labelSet.add(name);
    }

    const aliases = candidate['aliases'] ?? candidate['labels'];
    if (Array.isArray(aliases)) {
      for (const alias of aliases) {
        const normalized = coerceString(alias);
        if (normalized) {
          labelSet.add(normalized);
        }
      }
    }

    descriptors.push({
      id,
      labels: [...labelSet],
    });
  }

  return descriptors;
}

function coerceString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

type ChangesetResponseEntry = Omit<FeedbackChange, 'feedback_text'> & { prompt?: string };

function formatChangesetResponse(changes: FeedbackChange[]): ChangesetResponseEntry[] {
  return changes.map(({ feedback_text, ...rest }) => {
    if (!feedback_text) {
      return rest;
    }
    return {
      ...rest,
      prompt: feedback_text,
    };
  });
}

export async function startServer() {
  try {
    await fastify.listen({ port: config.server.port, host: config.server.host });
    fastify.log.info(`Server listening on ${config.server.host}:${config.server.port}`);
  } catch (error) {
    fastify.log.error(error);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}
