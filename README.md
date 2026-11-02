# dsh-better-moa

在 DeepSeek Harness 的 Agent loop 里并行调用多个参考模型，把意见注入聚合器上下文，让主模型在继续工作之前看到独立审阅。参考模型不拥有工具，聚合器保持 Agent loop 的完整控制权。

## 安装

```bash
dsh plugin install dsh-better-moa
```

## 配置

在 DSH 设置 → Better MoA 新增预设，选择聚合器路由和至少一个参考模型。设置自动保存，模型目录自动同步。

通用设置里的默认预设决定 `/moa` 和诊断用哪个预设；编辑器当前选中的预设与默认预设互不联动。

聚合器 reasoningEffort 默认跟随会话模型选择框。需要固定档位时单独选择；所选模型没有公开 effort 时只能跟随。

## 调用频率

| 模式 | 参考模型何时调用 |
|---|---|
| 每轮会话开始 | 每个用户回合开始时调用一次 |
| 每 N 轮工具迭代 | N=1–999；N=1 即每次迭代。旧 `per_iteration` 自动迁移到 N=1 |
| 智能参考调度 | 每轮开始调用一次；之后由判断器识别阶段完成时机，到 maxGap 时强制调用 |
| 每轮会话开始和结束 | 开始调用一次，结束前再做 QA；完整的 REVISE 意见让主模型在同一回合再改一轮 |

## 并行调用与注入

同一轮的所有参考请求并行启动。整批结果等全部完成（或达到超时/失败）后一次性封存，每轮至多注入一次；迟到的结果不补发。

**等待参考**（`wait`）：主模型在整批封存后继续执行。  
**后台参考**（`background`）：主模型继续执行；意见在下一个 pre-step 注入，Agent 结束时不追送。

结束 QA 追加在对话末尾，不覆盖本轮开始时的参考意见。参考意见与 QA 卡均可折叠；展示文本与注入主模型的前导指令分开显示。

## 智能调度器

所有 smart 预设共享通用设置里同一个调度器。每次工具迭代后，判断器评估是否刚完成一个阶段——是则立即咨询，否则继续等待。不配置判断器时只按 maxGap 强制触发。

支持的判断器：

- 宿主小模型 / 兼容 OpenAI chat 接口的小模型（填写 provider/model 和凭据环境变量）
- JEV（`TYPESAFE_API_KEY`）
- OpenAI Decisions 或 Luna Responses（`MOA_OPENAI_API_KEY`）

判断失败、超时或拒答均视为不介入，不中断 Agent loop。调度上下文默认 128000 字符（可配置 100000–512000）。

## 上下文与输出预算

参考模型收到的是调用前的宿主历史投影：包含对话、工具调用和结果，不含 MoA 意见本身（避免反馈循环）。每个参考按自己的窗口裁剪；配置的 `contextWindow` 优先于模型目录值。

输出上限（`maxTokens`）直接传给适配器。最终生效的上限还受渠道和中间件约束，例如某些 billion-context 版本会恢复带工具请求的输出预算。预算估算使用字符比例，不等同于供应商 tokenizer 的实际计数。

对于 bili 明确报告"未转发"的窗口拒绝，MoA 会记录有效上限并最多缩小重试一次；第二次失败直接报告，不循环重试。

## 缓存与会话

参考槽按主会话 + 预设 + 参考 id + provider/model 隔离，session id 在稳定窗口内保持不变，减少前缀重建。

声明 `adviceBoundary: true` 的路由在请求内插入固定分隔符：意见注入在分隔符之后，分隔符之前的前缀始终不变，缓存命中率最高。没有该能力的路由每轮注入都会改变消息序列，前缀缓存失效。

`sessionPolicy` 控制窗口重建时的传输身份：`stable` 保留 session id（适合能核对完整请求并重建历史的后端），`rotate` 更换 session id（适合有状态后端），`auto` 按路由特性自动选择。

## 路由能力声明

在 `presetOverrides` 的对应路由下配置：

```yaml
capabilities:
  nativeSession: true          # 后端按 sessionId 保存会话
  requestReconciliation: true  # 后端在历史改写后核对并重建会话
  adviceBoundary: true         # 启用固定分隔符保护前缀缓存
```

`requestReconciliation` 和 `adviceBoundary` 默认关闭，需要渠道明确支持后才开启。claude-tui 系列路由已验证支持全部三项；普通无状态 API 路由无需声明。

## 配置参考

| 配置项 | 默认值 / 含义 |
|---|---|
| defaultPreset | 空；`/moa` 和诊断的入口预设 |
| scheduler.minGap / maxGap | 2 / 12（工具迭代次数） |
| referenceTimeoutMs | 600000 ms；逐预设/逐参考可缩短 |
| deadlineMs | 900000 ms；参考阶段总时限 |
| reviewTimeoutMs | 60000 ms；结束 QA 总时限 |
| scheduler.stateChars | 128000 字符；调度上下文长度 |
| maxDialogueChars | 4000000 字符 |

`moa_status` 查看运行版本、预设和近期调用诊断。`moa_status {"action":"sync-client"}` 重建客户端资源后刷新 GUI。`/moa clear` 清除参考状态。`moa_probe` 和 `/moa <preset> <prompt>` 调用真实模型，产生费用。

## 发行说明

0.9.0 通过 313 项 Node.js 回归，覆盖窗口预算、批量超时、重复交付防护和结束 QA 生命周期。在线行为依赖渠道特性，须独立验证。
