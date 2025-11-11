import { z } from 'zod';

export const feedbackChangeSchema = z.object({
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
  target: z.union([
    z.literal('domain'),
    z.literal('segments'),
    z.literal('analysis'),
    z.literal('valueQuestions'),
  ]),
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

export const interpreterResponseSchema = z.object({
  changes: z.array(feedbackChangeSchema),
  reasoning: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export type InterpreterResponse = z.infer<typeof interpreterResponseSchema>;
