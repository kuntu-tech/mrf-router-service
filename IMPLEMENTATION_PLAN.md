## Stage 1: D1 维度提示词收紧
**Goal**: 收窄 `normalizeAnalysisDimension` 中的 D1 正则，避免“add market”类表达触发分析意图。
**Success Criteria**: `dimensionHintPatterns` 仅对“market size/opportunity/share”等量化短语命中；`npx tsc --noEmit` 通过。
**Tests**: `npx tsc --noEmit`
**Status**: Completed

## Stage 2: Segment 同义词词典扩充
**Goal**: 在 `normalizeTarget`、`mapHeuristicIntent`、`indicatesSegmentAddition` 等函数中加入 market/audience 等同义词，提升 `segment_add` 命中率。
**Success Criteria**: 新词典被单元测试覆盖，`segment_add` 针对“add market”句子命中；`npm test` 通过。
**Tests**: `npx tsc --noEmit`, `npm test`
**Status**: Completed

## Stage 3: 添加兜底纠偏规则
**Goal**: 在 `normalizeChange` 后流程增加检测，若出现添加类动词 + 市场类名词但被判为分析，强制调整为 `segment_add`。
**Success Criteria**: 新增规则单测覆盖误判案例，回归时保持原有分析场景不受影响。
**Tests**: `npm test`
**Status**: Completed

## Stage 4: Prompt 指令强化
**Goal**: 更新 system prompt，明确“引入/扩展市场或人群”必须使用 `segment_add`，并加入 D1 对照示例。
**Success Criteria**: `buildPrompt` 包含新增提示；`npx tsc --noEmit` 通过。
**Tests**: `npx tsc --noEmit`
**Status**: Completed

