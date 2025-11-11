import {
  FeedbackChange,
  Policy,
  RouterDependencies,
  RouterPlan,
  RouterRequest,
  Stage,
  STAGE_ORDER,
} from '../types';
import { RouterError } from './errors';

type ScopeBehavior = 'segments' | 'all' | 'none';

interface ChangeResolution {
  stage: Stage | null;
  propagate: Stage[];
  scopeBehavior: ScopeBehavior;
  expectedActions: string[];
  artifactImpacts: string[];
  allowVirtualSegments?: boolean;
}

interface EvaluatedChange {
  change: FeedbackChange;
  resolution: ChangeResolution;
  scope: 'all' | string[];
}

const DESTRUCTIVE_SEGMENT_INTENTS = new Set<FeedbackChange['intent']>(['segment_remove']);
const DESTRUCTIVE_QUESTION_INTENTS = new Set<FeedbackChange['intent']>(['value_question_remove']);

export const CONFIDENCE_THRESHOLD = 0.6;
const D1_DELTA_THRESHOLD = 1.5;

export function buildRouterPlan(request: RouterRequest, deps: RouterDependencies): RouterPlan {
  if (!request.changes.length) {
    throw new RouterError('EMPTY_CHANGES', 'Router requires at least one change.');
  }
  if (deps.baselineValidator && !deps.baselineValidator(request.baseRunId)) {
    throw new RouterError('BASELINE_NOT_FOUND', `Base run id ${request.baseRunId} is invalid.`);
  }

  const evaluatedChanges = request.changes.map((change) =>
    evaluateChange(change, request.policy, deps.scopeResolver),
  );

  enforceConflicts(evaluatedChanges);

  const propagateSet = new Set<Stage>();
  const actionSet = new Set<string>();
  const impactSet = new Set<string>();
  let planStage: Stage | null = null;
  let scopeAll = false;
  const scopeIds = new Set<string>();

  let requiresSegmentScope = false;

  for (const entry of evaluatedChanges) {
    const { resolution, scope } = entry;
    if (resolution.stage) {
      planStage = !planStage ? resolution.stage : minStage(planStage, resolution.stage);
    }

    resolution.propagate.forEach((stage) => propagateSet.add(stage));
    resolution.expectedActions.forEach((action) => actionSet.add(action));
    resolution.artifactImpacts.forEach((impact) => impactSet.add(impact));

    if (scope === 'all') {
      scopeAll = true;
    } else if (scope.length > 0) {
      scope.forEach((id) => scopeIds.add(id));
      requiresSegmentScope = true;
    }
  }

  const scope: 'all' | string[] = scopeAll ? 'all' : scopeIds.size ? [...scopeIds].sort() : [];
  if (planStage && requiresSegmentScope && scope !== 'all' && scope.length === 0) {
    throw new RouterError('EMPTY_SCOPE', 'Resolved rerun scope is empty.');
  }

  const propagate = orderStages(propagateSet, planStage);
  const steps = planStage ? orderStages(new Set<Stage>([planStage, ...propagate])) : [];

  return {
    baseRunId: request.baseRunId,
    policy: request.policy,
    mrf: planStage,
    scope,
    propagate,
    steps,
    expectedActions: [...actionSet],
    artifactImpacts: [...impactSet],
  };
}

function evaluateChange(
  change: FeedbackChange,
  policy: Policy,
  scopeResolver: RouterDependencies['scopeResolver'],
): EvaluatedChange {
  if (change.confidence < CONFIDENCE_THRESHOLD) {
    throw new RouterError(
      'LOW_CONFIDENCE',
      `Change confidence ${change.confidence} below threshold ${CONFIDENCE_THRESHOLD}.`,
    );
  }

  const resolution = resolveChange(change, policy);
  let scope: 'all' | string[] = [];

  switch (resolution.scopeBehavior) {
    case 'all':
      scope = 'all';
      break;
    case 'segments':
      scope = resolveSegmentScope(change, scopeResolver, resolution.allowVirtualSegments === true);
      break;
    case 'none':
    default:
      scope = [];
  }

  if (resolution.scopeBehavior === 'segments' && scope !== 'all' && scope.length === 0) {
    throw new RouterError('EMPTY_SCOPE', 'No segments matched the selector.');
  }

  return { change, resolution, scope };
}

function resolveSegmentScope(
  change: FeedbackChange,
  scopeResolver: RouterDependencies['scopeResolver'],
  allowVirtual: boolean,
): 'all' | string[] {
  try {
    return scopeResolver.resolve(change.selector, { required: true }).scope;
  } catch (error) {
    if (allowVirtual && error instanceof RouterError && error.code === 'SEGMENT_NOT_FOUND') {
      const fallback = extractSegmentIds(change.selector);
      if (fallback.length > 0) {
        return fallback;
      }
    }
    throw error;
  }
}

function extractSegmentIds(selector: FeedbackChange['selector']): string[] {
  if (!selector) {
    return [];
  }
  const tokens = Array.isArray(selector) ? selector : [selector];
  const ids = new Set<string>();
  for (const token of tokens) {
    if (!token) {
      continue;
    }
    const trimmed = token.trim();
    const idMatch = trimmed.match(/segments\[(?:segmentId|id)=([^\]]+)]/i);
    if (idMatch) {
      const [, captured] = idMatch;
      if (captured) {
        ids.add(stripQuotes(captured));
      }
      continue;
    }
    if (/^seg_[\w-]+$/i.test(trimmed)) {
      ids.add(trimmed);
    }
  }
  return [...ids];
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]/, '').replace(/['"]$/, '');
}

function enforceConflicts(entries: EvaluatedChange[]) {
  const tracker = new Map<string, Set<FeedbackChange['intent']>>();

  for (const entry of entries) {
    if (entry.scope === 'all' || entry.scope.length === 0) {
      continue;
    }

    const scopeIds = entry.scope;
    for (const segmentId of scopeIds) {
      const keys = buildConflictKeys(entry.change, segmentId);
      for (const key of keys) {
        const intents = tracker.get(key) ?? new Set<FeedbackChange['intent']>();
        if (intentsConflict(intents, entry.change.intent)) {
          throw new RouterError(
            'CONFLICTING_COMMANDS',
            `Conflicting intents detected for ${key}.`,
          );
        }
        intents.add(entry.change.intent);
        tracker.set(key, intents);
      }
    }
  }
}

function buildConflictKeys(change: FeedbackChange, segmentId: string): string[] {
  if (change.target === 'valueQuestions') {
    const questionKey = change.questionId ?? '*';
    return [`question::${segmentId}::${questionKey}`];
  }
  if (change.target === 'segments' || change.target === 'analysis') {
    return [`segment::${segmentId}`];
  }
  return [];
}

function intentsConflict(
  existing: Set<FeedbackChange['intent']>,
  candidate: FeedbackChange['intent'],
): boolean {
  if (DESTRUCTIVE_SEGMENT_INTENTS.has(candidate) && existing.size > 0) {
    return true;
  }
  if ([...existing].some((intent) => DESTRUCTIVE_SEGMENT_INTENTS.has(intent)) && candidate !== 'segment_remove') {
    return true;
  }
  if (DESTRUCTIVE_QUESTION_INTENTS.has(candidate) && existing.size > 0) {
    return true;
  }
  if (
    [...existing].some((intent) => DESTRUCTIVE_QUESTION_INTENTS.has(intent)) &&
    candidate !== 'value_question_remove'
  ) {
    return true;
  }
  return false;
}

function resolveChange(change: FeedbackChange, policy: Policy): ChangeResolution {
  switch (change.intent) {
    case 'domain_correction':
      return {
        stage: 'infer',
        propagate: ['segments', 'analyze', 'valueQs', 'feasibility'],
        scopeBehavior: 'all',
        expectedActions: ['Re-run entire pipeline for domain correction'],
        artifactImpacts: ['domain.changed', 'segments.regenerated', 'valueQuestions.regenerated'],
      };
    case 'segment_rescore':
      return {
        stage: 'segments',
        propagate: ['analyze', 'valueQs', 'feasibility'],
        scopeBehavior: 'segments',
        expectedActions: ['Rescore segments and refresh downstream artifacts'],
        artifactImpacts: ['segments.rescored', 'analysis.updated', 'valueQuestions.updated'],
      };
    case 'segment_add':
      return {
        stage: 'segments',
        propagate: ['analyze', 'valueQs', 'feasibility'],
        scopeBehavior: change.selector === undefined ? 'none' : 'segments',
        allowVirtualSegments: true,
        expectedActions: ['Add segment and refresh analysis/value questions'],
        artifactImpacts: ['segments.added', 'analysis.updated', 'valueQuestions.updated'],
      };
    case 'segment_edit':
      return {
        stage: 'segments',
        propagate: ['analyze', 'valueQs', 'feasibility'],
        scopeBehavior: 'segments',
        expectedActions: ['Regenerate segment and downstream analysis'],
        artifactImpacts: ['segments.changed', 'analysis.updated', 'valueQuestions.updated'],
      };
    case 'segment_merge':
      return {
        stage: 'segments',
        propagate: ['analyze', 'valueQs', 'feasibility'],
        scopeBehavior: 'segments',
        expectedActions: ['Merge segments and refresh downstream analysis'],
        artifactImpacts: ['segments.merged', 'analysis.updated', 'valueQuestions.updated'],
      };
    case 'segment_rename':
      return {
        stage: null,
        propagate: [],
        scopeBehavior: 'segments',
        expectedActions: ['Rename segment labels'],
        artifactImpacts: ['segments.metadata'],
      };
    case 'segment_remove':
      return {
        stage: 'segments',
        propagate: ['analyze', 'valueQs', 'feasibility'],
        scopeBehavior: 'segments',
        expectedActions: ['Remove segment and clean downstream artifacts'],
        artifactImpacts: ['segments.removed', 'analysis.updated', 'valueQuestions.updated'],
      };
    case 'analysis_recore':
      return resolveAnalysisRecore(change);
    case 'analysis_edit':
      return resolveAnalysisChange(change, policy);
    case 'analysis_rename':
      return {
        stage: 'analyze',
        propagate: [],
        scopeBehavior: 'segments',
        expectedActions: ['Rename analysis labels'],
        artifactImpacts: ['analysis.metadata'],
      };
    case 'value_question_add':
      return {
        stage: 'valueQs',
        propagate: ['feasibility'],
        scopeBehavior: 'segments',
        expectedActions: ['Add value question and revalidate feasibility'],
        artifactImpacts: ['valueQuestions.added', 'feasibility.updated'],
      };
    case 'value_question_rescore':
      return {
        stage: 'valueQs',
        propagate: ['feasibility'],
        scopeBehavior: 'segments',
        expectedActions: ['Rescore value questions and revalidate feasibility'],
        artifactImpacts: ['valueQuestions.rescored', 'feasibility.updated'],
      };
    case 'value_question_remove':
      return {
        stage: 'valueQs',
        propagate: [],
        scopeBehavior: 'segments',
        expectedActions: ['Remove value question'],
        artifactImpacts: ['valueQuestions.removed'],
      };
    case 'value_question_edit':
      return {
        stage: 'valueQs',
        propagate: ['feasibility'],
        scopeBehavior: 'segments',
        expectedActions: ['Update value question wording and revalidate feasibility'],
        artifactImpacts: ['valueQuestions.updated', 'feasibility.updated'],
      };
    default:
      return {
        stage: null,
        propagate: [],
        scopeBehavior: 'none',
        expectedActions: [],
        artifactImpacts: [],
      };
  }
}

function resolveAnalysisRecore(change: FeedbackChange): ChangeResolution {
  const dimension = change.dimension;
  const expectedActions = dimension
    ? [`Rescore analysis ${dimension}`]
    : ['Rescore analysis dimensions'];
  const artifactImpacts = dimension ? [`analysis.${dimension}`] : ['analysis.rescored'];

  return {
    stage: 'analyze',
    propagate: ['valueQs', 'feasibility'],
    scopeBehavior: 'segments',
    expectedActions,
    artifactImpacts: [...artifactImpacts, 'valueQuestions.updated', 'feasibility.updated'],
  };
}

function resolveAnalysisChange(change: FeedbackChange, policy: Policy): ChangeResolution {
  const dimension = change.dimension ?? 'D2';
  const propagate = determineAnalysisPropagation(dimension, policy, change.delta);
  const expectedActions = [`Update analysis ${dimension}`];

  if (propagate.includes('valueQs')) {
    expectedActions.push('Regenerate value questions');
  }
  if (propagate.includes('feasibility')) {
    expectedActions.push('Re-evaluate feasibility');
  }

  const artifactImpacts = [`analysis.${dimension}`];
  if (propagate.includes('valueQs')) {
    artifactImpacts.push('valueQuestions.updated');
  }
  if (propagate.includes('feasibility')) {
    artifactImpacts.push('feasibility.updated');
  }

  return {
    stage: 'analyze',
    propagate,
    scopeBehavior: 'segments',
    expectedActions,
    artifactImpacts,
  };
}

function determineAnalysisPropagation(
  dimension: string,
  policy: Policy,
  delta = 0,
): Stage[] {
  if (dimension === 'D1') {
    if (policy === 'aggressive') {
      return ['valueQs', 'feasibility'];
    }
    if (policy === 'conservative') {
      return [];
    }
    return delta >= D1_DELTA_THRESHOLD ? ['valueQs', 'feasibility'] : [];
  }

  if (dimension === 'D2') {
    return ['valueQs', 'feasibility'];
  }

  if (dimension === 'D3' || dimension === 'D4') {
    if (policy === 'aggressive') {
      return ['valueQs', 'feasibility'];
    }
    return ['feasibility'];
  }

  return ['valueQs', 'feasibility'];
}

function minStage(a: Stage, b: Stage): Stage {
  const indexA = STAGE_ORDER.indexOf(a);
  const indexB = STAGE_ORDER.indexOf(b);
  const minIndex = Math.min(indexA, indexB);
  return STAGE_ORDER[minIndex] ?? a;
}

function orderStages(stages: Iterable<Stage>, minimum?: Stage | null): Stage[] {
  const items = [...new Set(stages)];
  return items
    .filter((stage) => (minimum ? STAGE_ORDER.indexOf(stage) >= STAGE_ORDER.indexOf(minimum) : true))
    .sort((left, right) => STAGE_ORDER.indexOf(left) - STAGE_ORDER.indexOf(right));
}
