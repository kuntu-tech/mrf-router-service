# mrf-router-service

Lightweight router that turns natural language feedback into deterministic rerun plans (MRF plans) for the BusinessInsight prototype. It stitches together an OpenAI-driven interpreter, a deterministic router, and a small scope resolver so that every request resolves how much of the downstream pipeline must rerun, which segments are affected, and what artifacts need to refresh.

## Quickstart

1. `npm install`
2. Provide your OpenAI API key (default env var: `OPENAI_API_KEY`).
3. `OPENAI_API_KEY=sk-xxx npm run dev` (runs `ts-node src/server.ts` on `0.0.0.0:4000`).
4. `npm run build` to emit `dist`, `npm run typecheck` to run `tsc --noEmit`, and `npm run test` to execute the `vitest` suite.

## Key concepts

### Interpreter pipeline

`interpretFeedback` (see `src/interpreter/openaiInterpreter.ts`) is the only place that talks to OpenAI. It:

- builds a multi-rule prompt that demands only the canonical intents (`add`, `edit`, `rename`, `remove`, `merge`, `rescore`) and targets (`domain`, `segment`, `analysis`, `valueQuestions`), asks for selectors such as `segments[segmentId=seg_01].analysis.D2`, and lists synonyms for analysts.
- posts the prompt to `config.interpreter.model` (default `gpt-4.1-mini`) with `temperature: 0.1`, then extracts the first JSON blob it can find (`sanitizeJson`, `extractJsonText`, `normalizeInterpreterResponse`).
- normalizes the output so that any alias (`commands`, `actions`, `updates`, etc.) collapses into a `changes` array, canonicalizes intents based on target, infers targets from keywords/selectors, enforces selectors (segments, value questions, analysis dimensions), and ensures `confidence` exists (default threshold: `config.interpreter.confidenceThreshold`, 0.6).
- passes the interpreter output through several helpers (`attachFeedbackText`, `ensureConfidence`, `ensureDomainSelectors`, `applyDimensionHints`, `ensureChanges`). These steps:
  * augment every change with the submitted `feedback_text` when missing,
  * drop the confidence to the configured floor if absent,
  * force domain changes to keep their selector as `domain`,
  * rewrite selectors to append the detected dimension (`market opportunity => D1`, `customer persona => D2`, `competitive advantage => D3`, `revenue potential => D4`),
  * fall back to derived edits (domain scope change, value question removal, analysis edits) when the model returns no change.
- returns a `changeset` response that mirrors the cleaned `FeedbackChange` objects but exposes `prompt` (the original `feedback_text`) instead of shuttling `feedback_text` through the wire.

### Router plan generation

`buildRouterPlan` (`src/router/mrfRouter.ts`) consumes the cleaned `FeedbackChange[]` and a `ScopeResolver`. The plan:

- validates there is at least one change and that the provided `baseRunId` passes `validateBaseline` (unless `config.baseline.allowMissing` is true, it must start with `r_`), otherwise it throws a `RouterError`.
- evaluates each change to map intent → rerun stage, propagation steps, and terms such as `expectedActions` and `artifactImpacts`. Mapping highlights:
  * `analysis_edit` reruns the `analyze` stage and propagates to `valueQs`/`feasibility` depending on `determineAnalysisPropagation` (see below).
  * `analysis_recore` always reruns `analyze` and cascades to `valueQs`/`feasibility`.
  * `analysis_rename` keeps work within the `analyze` frontier.
  * `value_question_add/edit/rescore` rerun `valueQs` and revalidate feasibility; removals only affect `valueQs`.
  * `segment_*` intents rerun `segment` plus downstream stages.
- resolves selectors with `resolveSegmentScope`, which uses the provided `ScopeResolver` to turn strings like `segments[segmentId=seg_01]`, `segments[name=Fashion]`, `seg_01`, or the token `segments`/`*`/`all` into segment IDs (or `'all'`). Virtual segments (e.g., for `segment_add`) are allowed via `allowVirtualSegments`.
- tracks conflicting commands (`segment_remove` vs. other segment edits, value question removes vs. other question actions) and throws `RouterError('CONFLICTING_COMMANDS')` if they collide.
- collapses the resolved `scope` into either `'all'` or a sorted array of segment IDs. If any change demands segments but none can be resolved, it errors with `EMPTY_SCOPE`.
- sets `plan.mrf` to the earliest stage (`STAGE_ORDER = ['infer','segments','analyze','valueQs','feasibility']`) touched by the changes, orders `propagate` and `steps` using that stage order, and returns `expectedActions`/`artifactImpacts` for instrumentation.

`determineAnalysisPropagation` rules:

- `D1`: `conservative` stops at `analyze`, `aggressive` propagates to `valueQs` and `feasibility`, `standard` only propagates if `delta >= 1.5`.
- `D2`: always propagates to `valueQs` and `feasibility`.
- `D3`/`D4`: `aggressive` propagates to both, others only revalidate `feasibility`.
- unknown dimensions fall back to both `valueQs` and `feasibility`.

### Scope resolver

`InMemoryScopeResolver` builds an alias index from `SegmentDescriptor[]` (the default dataset is `demoSegments` in `src/data/segments.ts`). Each descriptor exposes an `id` plus labels (names, aliases, even Chinese names). `resolve(selector)`:

- treats `all`, `segments`, or `*` as `'all'`.
- supports selectors like `segments[segmentId=seg_01]`, `segments[id=seg_accessories]`, `segments[name=Fashion]`, or bare IDs/names.
- throws `SEGMENT_NOT_FOUND` when nothing matches and `SEGMENT_NOT_UNIQUE` when a label matches multiple IDs.
- respects `options.allowAll` (used when a change explicitly needs `'all'`) and `required` to decide if missing selectors are fatal.

## API

### POST /api/v1/feedback-mrf/interpret

Interprets free-text feedback without touching the router.

Request:

```json
{
  "feedback_text": "Pair segment 1 with European buyers",
  "base_run_id": "r_4",
  "current_data": {
    "segments": [
      { "segmentId": "seg_01", "name": "Segment 1" }
    ]
  }
}
```

Response:

```json
{
  "model": "gpt-4.1-mini",
  "threshold": 0.6,
  "changeset": [
    {
      "intent": "analysis_edit",
      "target": "analysis",
      "selector": "segments[segmentId=seg_01].analysis.D2",
      "dimension": "D2",
      "confidence": 0.85,
      "prompt": "Pair segment 1 with European buyers"
    }
  ],
  "reasoning": ["..."]
}
```

### POST /api/v1/feedback-mrf/preview

Runs the deterministic router on a supplied `changes` array without invoking OpenAI. Use this endpoint to validate routing logic before committing to a rerun.

Request schema:

```json
{
  "base_run_id": "r_4",
  "policy": "standard",
  "changes": [ /* FeedbackChange[] */ ]
}
```

Response:

```json
{
  "plan": {
    "baseRunId": "r_4",
    "policy": "standard",
    "mrf": "analyze",
    "scope": ["seg_01"],
    "propagate": ["valueQs", "feasibility"],
    "steps": ["analyze", "valueQs", "feasibility"],
    "expectedActions": ["Update analysis D2", "Regenerate value questions", "Re-evaluate feasibility"],
    "artifactImpacts": ["analysis.D2", "valueQuestions.updated", "feasibility.updated"]
  }
}
```

### POST /api/v1/feedback-mrf/plan

Runs the full feedback loop: interpret → normalize → route. Accepts optional `user_id`, `task_id`, and `current_data` (for selector resolution).

Request:

```json
{
  "feedback_text": "...",
  "base_run_id": "r_5",
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "task_id": "d330f...",
  "policy": "standard",
  "current_data": { "...": "..." }
}
```

Response:

```json
{
  "base_run_id": "r_5",
  "user_id": "...",
  "task_id": "...",
  "model": "gpt-4.1-mini",
  "changeset": [ /* normalized changes */ ],
  "plan": { /* RouterPlan */ },
  "reasoning": ["..."]
}
```

`plan` is identical to the `buildRouterPlan` return value (`baseRunId`, `policy`, `mrf`, `scope`, `propagate`, `steps`, `expectedActions`, `artifactImpacts`).

### Error handling

- `LOW_CONFIDENCE`, `EMPTY_SCOPE`, `SEGMENT_NOT_FOUND`, `SEGMENT_NOT_UNIQUE` → HTTP 422.
- `CONFLICTING_COMMANDS` or `SCHEMA_CHANGED` → 409.
- `BASELINE_NOT_FOUND` → 404.
- All other `RouterError` codes default to 400.

Any unexpected interpreter failure returns 502 with `INTERPRETER_FAILED` or `INTERPRETER_OR_ROUTER_FAILED`.

## Data contracts

### FeedbackChange (see `src/types.ts`)

Fields:

- `intent`: one of the allowable feedback intents.
- `target`: canonical router nodes.
- `selector`: TRL-style selector (`segments[segmentId=seg_01].analysis.D2`, `segments[name=Fashion].valueQuestions`).
- `dimension`: sparsely set for analysis edits.
- `questionId`, `delta`, `scopeAll`, `metadata`: optional hints.
- `confidence`: must be between 0 and 1; the interpreter enforces a floor of 0.6.

### RouterPlan

```ts
{
  baseRunId: string;
  policy: 'conservative' | 'standard' | 'aggressive';
  mrf: Stage | null;
  scope: 'all' | string[];
  propagate: Stage[];
  steps: Stage[];
  expectedActions: string[];
  artifactImpacts: string[];
}
```

`Stage` order is `[infer, segment, analyze, valueQs, feasibility]`. `propagate` and `steps` are sorted by that order. `scope` is `'all'` when a change touches the entire pipeline.

### Interpreter response

`interpretFeedback` returns `{ changes: FeedbackChange[]; reasoning?: string[] }`. The HTTP `/interpret` response wraps this payload with `model` and `threshold`, and the router calls `formatChangesetResponse` to drop `feedback_text` in favor of `prompt`.

## Heuristics & fallbacks

- `applyDimensionHints` inspects the feedback for `market opportunity`, `customer persona`, `competitive advantage`, or `revenue potential` and rewrites selectors/dimension values accordingly.
- `enforce*` helpers ensure selectors target the right namespace:
  * missing segment selectors degrade to `'segments'` with `scopeAll` set when the model references the whole segmentation.
  * value-question additions infer the owning segment from `current_data` or set `selector = 'segments'` when ambiguous.
  * analysis edits append `.analysis.Dn` to the selector.
- If the interpreter returns zero changes, `ensureChanges` tries to derive one automatically (domain scope change, value question removal by matching text to `current_data`, or dimension-based analysis edit).

## Configuration

- `config/service.config.json` sets the defaults: host `0.0.0.0`, port `4000`, policy `standard`, interpreter threshold `0.6`, model `gpt-4.1-mini`, OpenAI key stored in `OPENAI_API_KEY`, and `baseline.allowMissing` default `false`.
- `validateBaseline` enforces that `baseRunId` starts with `r_` unless `allowMissing` is true.
- `router` exposes `Policy` options `conservative`, `standard`, and `aggressive`.

## Demo segments & scope resolution

The built-in `demoSegments` list seeds `InMemoryScopeResolver`. Each descriptor includes IDs such as `seg_01`, `seg_accessories`, and human-friendly labels (`segment 1`, `fashion enterprise`, `regional accessories buyers`). Pass richer `current_data.segments` to `/plan` to override the resolver and enable the interpreter to match names and aliases.

## Scripts

- `npm run dev` — launches the Fastify server via `ts-node`.
- `npm run build` / `npm run typecheck` — compile/type-check the TypeScript sources.
- `npm run test` — runs `vitest` for business logic.

## Testing & validation

The `vitest` suite currently focuses on `router` plan construction and scope resolver behavior. Inspect `dist` or run `npm run test` locally before deploying.
