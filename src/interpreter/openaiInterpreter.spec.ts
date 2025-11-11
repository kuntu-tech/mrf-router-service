import { describe, expect, it } from 'vitest';

import { __TESTING__ } from './openaiInterpreter';
import type { FeedbackChange } from '../types';

describe('openaiInterpreter intent heuristics', () => {
  it('prefers segment_add for missing segment phrasing', () => {
    const payload = {
      changes: [
        {
          intent: '',
          target: 'segments',
          selector: undefined,
          confidence: 0.8,
          feedback_text: "We're missing a segment for enterprise customers. Please add one.",
        },
      ],
    };

    const result = __TESTING__.normalizeInterpreterResponse(payload) as { changes: FeedbackChange[] };
    expect(result.changes).toHaveLength(1);
    const change = result.changes[0]!;

    expect(change.intent).toBe('segment_add');
    expect(change.target).toBe('segments');
    expect(change.selector).toBe('segments');
    expect(change.scopeAll).toBe(true);
  });

  it('detects value_question_rescore for rescore requests', () => {
    const payload = {
      changes: [
        {
          intent: '',
          target: 'valueQuestions',
          selector: 'segments[segmentId=seg_01].valueQuestions',
          confidence: 0.7,
          feedback_text: 'Rescore the value questions for segment seg_01.',
        },
      ],
    };

    const result = __TESTING__.normalizeInterpreterResponse(payload) as { changes: FeedbackChange[] };
    expect(result.changes).toHaveLength(1);
    const change = result.changes[0]!;

    expect(change.intent).toBe('value_question_rescore');
    expect(change.target).toBe('valueQuestions');
  });

  it('maps analysis rescore phrasing to analysis_recore', () => {
    const payload = {
      changes: [
        {
          intent: '',
          target: 'analysis',
          selector: 'segments[segmentId=seg_02].analysis',
          confidence: 0.75,
          feedback_text: 'Please rescore the analysis for segment 2.',
        },
      ],
    };

    const result = __TESTING__.normalizeInterpreterResponse(payload) as { changes: FeedbackChange[] };
    expect(result.changes).toHaveLength(1);
    const change = result.changes[0]!;

    expect(change.intent).toBe('analysis_recore');
    expect(change.target).toBe('analysis');
  });

  it('treats add market phrasing as segment_add', () => {
    const payload = {
      changes: [
        {
          intent: 'analysis_edit',
          target: 'analysis',
          selector: undefined,
          confidence: 0.8,
          feedback_text: 'We need to add a consumer market targeting pound users.',
        },
      ],
    };

    const result = __TESTING__.normalizeInterpreterResponse(payload) as { changes: FeedbackChange[] };
    expect(result.changes).toHaveLength(1);
    const change = result.changes[0]!;

    expect(change.intent).toBe('segment_add');
    expect(change.target).toBe('segments');
    expect(change.selector).toBe('segments');
    expect(change.scopeAll).toBe(true);
    expect(change.dimension).toBeUndefined();
  });

  it('does not infer D1 for non-quantitative market statements', () => {
    const payload = {
      changes: [
        {
          intent: '',
          target: '',
          selector: undefined,
          confidence: 0.8,
          feedback_text: 'Add a new market for 2C consumers in the UK.',
        },
      ],
    };

    const result = __TESTING__.normalizeInterpreterResponse(payload) as { changes: FeedbackChange[] };
    expect(result.changes).toHaveLength(1);
    const change = result.changes[0]!;

    expect(change.intent).toBe('segment_add');
    expect(change.target).toBe('segments');
    expect(change.selector).toBe('segments');
    expect(change.dimension).toBeUndefined();
  });

  it('still infers D1 when explicit market size mentioned', () => {
    const payload = {
      changes: [
        {
          intent: '',
          target: '',
          selector: undefined,
          confidence: 0.8,
          feedback_text: 'Update segment analysis with new market size estimates for D1.',
        },
      ],
    };

    const result = __TESTING__.normalizeInterpreterResponse(payload) as { changes: FeedbackChange[] };
    expect(result.changes).toHaveLength(1);
    const change = result.changes[0]!;

    expect(change.intent).toBe('analysis_edit');
    expect(change.target).toBe('analysis');
    expect(change.dimension).toBe('D1');
  });

  it('routes market questions to value question add', () => {
    const payload = {
      changes: [
        {
          intent: '',
          target: '',
          selector: undefined,
          confidence: 0.8,
          feedback_text: 'Add two new questions about the UK market and our pound users.',
        },
      ],
    };

    const result = __TESTING__.normalizeInterpreterResponse(payload) as { changes: FeedbackChange[] };
    expect(result.changes).toHaveLength(1);
    const change = result.changes[0]!;

    expect(change.intent).toBe('value_question_add');
    expect(change.target).toBe('valueQuestions');
    expect(change.selector).toBe('segments');
  });

  it('recognises analysis directive for market opportunity', () => {
    const payload = {
      changes: [
        {
          intent: '',
          target: '',
          selector: undefined,
          confidence: 0.8,
          feedback_text: 'Analyze the UK market opportunity and refresh the scoring.',
        },
      ],
    };

    const result = __TESTING__.normalizeInterpreterResponse(payload) as { changes: FeedbackChange[] };
    expect(result.changes).toHaveLength(1);
    const change = result.changes[0]!;

    expect(change.intent).toBe('analysis_edit');
    expect(change.target).toBe('analysis');
    expect(change.dimension).toBe('D1');
  });
});

