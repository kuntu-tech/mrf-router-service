import { describe, expect, it } from 'vitest';

import { buildRouterPlan, demoSegments, InMemoryScopeResolver, RouterError } from '..';
import type { Policy } from '..';

const scopeResolver = new InMemoryScopeResolver(demoSegments);

function plan(changes: Parameters<typeof buildRouterPlan>[0]['changes'], policy: Policy = 'standard') {
  return buildRouterPlan(
    {
      baseRunId: 'r_5',
      policy,
      changes,
    },
    { scopeResolver },
  );
}

describe('MRF Router Expected Behavior Matrix', () => {
  it('domain correction triggers infer frontier with full propagation', () => {
    const result = plan([{ intent: 'domain_correction', target: 'domain', confidence: 0.91 }]);
    expect(result.mrf).toBe('infer');
    expect(result.scope).toBe('all');
    expect(result.steps).toEqual(['infer', 'segment', 'analyze', 'valueQs', 'feasibility']);
  });

  it('adding a segment reruns segment stage and cascades', () => {
    const result = plan([
      {
        intent: 'segment_add',
        target: 'segment',
        selector: 'segments[segmentId=seg_new_eu]',
        confidence: 0.92,
      },
    ]);
    expect(result.mrf).toBe('segment');
    expect(result.scope).toEqual(['seg_new_eu']);
    expect(result.steps).toEqual(['segment', 'analyze', 'valueQs', 'feasibility']);
  });

  it('editing a segment regenerates downstream analysis', () => {
    const result = plan([
      {
        intent: 'segment_edit',
        target: 'segment',
        selector: 'segments[segmentId=seg_02]',
        confidence: 0.9,
      },
    ]);
    expect(result.mrf).toBe('segment');
    expect(result.scope).toEqual(['seg_02']);
    expect(result.propagate).toEqual(['analyze', 'valueQs', 'feasibility']);
  });

  it('merging segments rebuilds inputs', () => {
    const result = plan([
      {
        intent: 'segment_merge',
        target: 'segment',
        selector: ['segments[name=Fashion]', 'segments[name=Accessories]'],
        confidence: 0.93,
      },
    ]);
    expect(result.scope).toEqual(['seg_accessories', 'seg_fashion']);
    expect(result.steps).toEqual(['segment', 'analyze', 'valueQs', 'feasibility']);
  });

  it('rescoring segments touches the full downstream pipeline', () => {
    const result = plan([
      {
        intent: 'segment_rescore',
        target: 'segment',
        selector: 'segments',
        confidence: 0.9,
      },
    ]);
    expect(result.mrf).toBe('segment');
    expect(result.scope).toBe('all');
    expect(result.steps).toEqual(['segment', 'analyze', 'valueQs', 'feasibility']);
  });

  it('editing D1 with a large delta propagates value questions under standard policy', () => {
    const result = plan([
      {
        intent: 'analysis_edit',
        target: 'analysis',
        selector: 'segments[segmentId=seg_03].analysis.D1',
        dimension: 'D1',
        delta: 2.1,
        confidence: 0.9,
      },
    ]);
    expect(result.mrf).toBe('analyze');
    expect(result.scope).toEqual(['seg_03']);
    expect(result.propagate).toEqual(['valueQs', 'feasibility']);
  });

  it('editing D2 regenerates questions and feasibility', () => {
    const result = plan([
      {
        intent: 'analysis_edit',
        target: 'analysis',
        selector: 'segments[segmentId=seg_01].analysis.D2',
        dimension: 'D2',
        confidence: 0.95,
      },
    ]);
    expect(result.propagate).toEqual(['valueQs', 'feasibility']);
  });

  it('editing D3 only revalidates feasibility by default', () => {
    const result = plan([
      {
        intent: 'analysis_edit',
        target: 'analysis',
        selector: 'segments[segmentId=seg_02].analysis.D3',
        dimension: 'D3',
        confidence: 0.9,
      },
    ]);
    expect(result.propagate).toEqual(['feasibility']);
    expect(result.steps).toEqual(['analyze', 'feasibility']);
  });

  it('analysis recore always cascades to questions and feasibility', () => {
    const result = plan([
      {
        intent: 'analysis_recore',
        target: 'analysis',
        selector: 'segments[segmentId=seg_01].analysis',
        confidence: 0.9,
      },
    ]);
    expect(result.mrf).toBe('analyze');
    expect(result.propagate).toEqual(['valueQs', 'feasibility']);
  });

  it('analysis rename only updates metadata', () => {
    const result = plan([
      {
        intent: 'analysis_rename',
        target: 'analysis',
        selector: 'segments[segmentId=seg_01].analysis.D2',
        dimension: 'D2',
        confidence: 0.9,
      },
    ]);
    expect(result.mrf).toBe('analyze');
    expect(result.propagate).toEqual([]);
    expect(result.steps).toEqual(['analyze']);
  });

  it('adding a value question reruns feasibility', () => {
    const result = plan([
      {
        intent: 'value_question_add',
        target: 'valueQuestions',
        selector: 'segments[segmentId=seg_02].valueQuestions',
        confidence: 0.96,
      },
    ]);
    expect(result.mrf).toBe('valueQs');
    expect(result.steps).toEqual(['valueQs', 'feasibility']);
  });

  it('removing a value question stays within valueQs frontier', () => {
    const result = plan([
      {
        intent: 'value_question_remove',
        target: 'valueQuestions',
        selector: 'segments[segmentId=seg_02].valueQuestions[id=q_04]',
        questionId: 'q_04',
        confidence: 0.9,
      },
    ]);
    expect(result.mrf).toBe('valueQs');
    expect(result.propagate).toEqual([]);
    expect(result.steps).toEqual(['valueQs']);
  });

  it('editing a value question revalidates feasibility', () => {
    const result = plan([
      {
        intent: 'value_question_edit',
        target: 'valueQuestions',
        selector: 'segments[segmentId=seg_01].valueQuestions[id=q_02]',
        questionId: 'q_02',
        confidence: 0.9,
      },
    ]);
    expect(result.mrf).toBe('valueQs');
    expect(result.propagate).toEqual(['feasibility']);
  });

  it('rescoring value questions cascades to feasibility', () => {
    const result = plan([
      {
        intent: 'value_question_rescore',
        target: 'valueQuestions',
        selector: 'segments[segmentId=seg_01].valueQuestions',
        confidence: 0.94,
      },
    ]);
    expect(result.mrf).toBe('valueQs');
    expect(result.propagate).toEqual(['feasibility']);
  });

  it('multi-command batches merge scope and propagation', () => {
    const result = plan(
      [
        {
          intent: 'analysis_edit',
          target: 'analysis',
          selector: 'segments[segmentId=seg_01].analysis.D2',
          dimension: 'D2',
          confidence: 0.9,
        },
        {
          intent: 'value_question_add',
          target: 'valueQuestions',
          selector: 'segments[segmentId=seg_03].valueQuestions',
          confidence: 0.93,
        },
      ],
      'standard',
    );
    expect(result.mrf).toBe('analyze');
    expect(result.scope).toEqual(['seg_01', 'seg_03']);
    expect(result.propagate).toEqual(['valueQs', 'feasibility']);
  });

  it('segment rename only adjusts metadata', () => {
    const result = plan([
      { intent: 'segment_rename', target: 'segment', selector: 'segments[segmentId=seg_03]', confidence: 0.9 },
    ]);
    expect(result.mrf).toBeNull();
    expect(result.scope).toEqual(['seg_03']);
    expect(result.steps).toEqual([]);
  });

  it('conflicting commands throw CONFLICTING_COMMANDS', () => {
    expect(() =>
      plan([
        { intent: 'segment_remove', target: 'segment', selector: 'segments[segmentId=seg_02]', confidence: 0.92 },
        {
          intent: 'analysis_edit',
          target: 'analysis',
          selector: 'segments[segmentId=seg_02].analysis.D2',
          dimension: 'D2',
          confidence: 0.9,
        },
      ]),
    ).toThrowError(RouterError);
  });

  it('low confidence feedback is rejected', () => {
    expect(() =>
      plan([{ intent: 'analysis_edit', target: 'analysis', selector: 'segments[segmentId=seg_01]', confidence: 0.4 }]),
    ).toThrowError(RouterError);
  });
});

describe('Policy variations & edge expectations', () => {
  it('conservative policy skips value question regeneration for D1 edits', () => {
    const result = plan(
      [
        {
          intent: 'analysis_edit',
          target: 'analysis',
          selector: 'segments[segmentId=seg_01].analysis.D1',
          dimension: 'D1',
          delta: 3,
          confidence: 0.93,
        },
      ],
      'conservative',
    );
    expect(result.propagate).toEqual([]);
  });

  it('aggressive policy regenerates value questions even for D3 edits', () => {
    const result = plan(
      [
        {
          intent: 'analysis_edit',
          target: 'analysis',
          selector: 'segments[segmentId=seg_02].analysis.D3',
          dimension: 'D3',
          confidence: 0.95,
        },
      ],
      'aggressive',
    );
    expect(result.propagate).toEqual(['valueQs', 'feasibility']);
  });

  it('D1 edits below threshold stay within analyze step under standard policy', () => {
    const result = plan([
      {
        intent: 'analysis_edit',
        target: 'analysis',
        selector: 'segments[segmentId=seg_01].analysis.D1',
        dimension: 'D1',
        delta: 0.5,
        confidence: 0.94,
      },
    ]);
    expect(result.propagate).toEqual([]);
    expect(result.steps).toEqual(['analyze']);
  });
});
