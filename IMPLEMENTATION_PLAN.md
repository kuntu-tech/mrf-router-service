## Stage 1: 类型定义与校验更新
**Goal**: 统一 `FeedbackIntent` 与 `FeedbackChange.target` 的类型定义与 Zod 校验，仅保留需求中的取值。
**Success Criteria**: `src/types.ts` 与相关 schema 更新后无编译错误；`npx tsc --noEmit` 通过。
**Tests**: `npx tsc --noEmit`
**Status**: Complete

## Stage 2: 解释器裁剪
**Goal**: 删除 `openaiInterpreter` 中所有涉及已移除意图/目标的映射、推断与派生逻辑。
**Success Criteria**: `src/interpreter/openaiInterpreter.ts` 编译通过且不再引用被删除的意图/目标。
**Tests**: `npx tsc --noEmit`
**Status**: Complete

## Stage 3: 路由与服务层清理
**Goal**: 移除 `mrfRouter`、`server` 等处对已删除意图/目标的处理及相关测试。
**Success Criteria**: 相关文件无无效引用；单元测试编译通过。
**Tests**: `npm test`
**Status**: Complete

## Stage 4: 测试与验证
**Goal**: 运行必要测试确认无回归，清理死代码。
**Success Criteria**: 所有目标测试通过；`git status` 仅显示预期改动。
**Tests**: `npx tsc --noEmit`, `npm test`
**Status**: Complete

