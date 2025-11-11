## Stage 1: Target 判定去默认兜底
**Goal**: 移除 `ensureAllowedTargetValue` 及相关流程对 `segments` 的默认回退，改为返回 `undefined` 并由上层提示/测试兜底。
**Success Criteria**: target 判定在无信号时不会落到 `segments`；新增测试覆盖空信号场景。
**Tests**: `npm test`
**Status**: Completed

## Stage 2: 关键词词典分层
**Goal**: 将 segment/market/audience 词典拆分，引入上下文判断，避免 questions/analysis 被 segment 关键词误伤。
**Success Criteria**: 新增 helper 区分 `segmentTokens`、`marketTokens`、`audienceTokens`；测试覆盖“question about market”正确归类到 valueQuestions。
**Tests**: `npm test`
**Status**: Completed

## Stage 3: Questions & Analysis 信号增强
**Goal**: 扩充 questions/analysis 的关键词及正则，优先命中这些目标并在 fallback 前二次校验。
**Success Criteria**: 新增 heuristics 准确识别问题/分析相关指令；对应测试通过。
**Tests**: `npm test`
**Status**: Completed

## Stage 4: 移除 Segment 兜底回落
**Goal**: 删除 `applySegmentAdditionFallback` 等将模糊场景强制改为 segment 的逻辑，改以提示或保持原判。
**Success Criteria**: 相关函数移除或改写；关键测试更新且通过。
**Tests**: `npm test`
**Status**: Completed

