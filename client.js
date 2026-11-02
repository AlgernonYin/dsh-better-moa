/*
 * dsh-better-moa browser client, 0.6.2.
 *
 * This file is deliberately self-contained: Harness ModuleLoader resolves bare
 * package specifiers, not relative modules such as require('./settings-panel.js').
 * The Node-only module in settings-panel.js evaluates this real browser bundle
 * for offline tests; it is not a second runtime implementation.
 */
window.__ModuleLoader__.load({
  id: 'dsh-better-moa',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const module = { exports: {} }
    const exports = module.exports

    const NS = 'moa.settings'
    const SETTINGS_NS = 'better-moa'
    const FANOUT_MAX = 999

    /**
     * Keys the panel owns inside a preset entry. Everything else in the Host
     * document (prompts, Hermes metadata, future fields) rides along untouched:
     * presetOverrides is a user-owned table, so a save must never rebuild an
     * entry from scratch and silently drop what this UI does not edit.
     */
    const MANAGED_PRESET_KEYS = ['id', 'label', 'description', 'fanout', 'aggregator', 'scheduler', 'references', 'delivery', 'referenceTimeoutMs']
    const MANAGED_AGGREGATOR_KEYS = ['provider', 'model', 'effortMode', 'reasoningEffort']
    // Keep these limits identical to scheduler.js: invalid edits never enter the Host document.
    const DECISION_DEFAULTS = {
      kind: 'none', threshold: 0.6, minGap: 2, maxGap: 12, timeoutMs: 20000, stateChars: 128000,
      credentialRef: 'TYPESAFE_API_KEY', model: 'jev-latest',
      baseURL: 'https://api.typesafe.ai/v1/systemone', cacheMode: 'explicit', api: '',
    }
    const DECISION_NUMBERS = ['threshold', 'minGap', 'maxGap', 'timeoutMs', 'stateChars']
    const DECISION_KINDS = ['none', 'dsh-model', 'openai-compatible', 'jev', 'openai-decisions']
    const OPENAI_COMPATIBLE_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages']
    const LEGACY_DECISION_KINDS = { model: 'dsh-model', jev: 'jev', decisions: 'openai-decisions', openai: 'openai-compatible' }
    const decisionKind = value => DECISION_KINDS.includes(value) ? value : LEGACY_DECISION_KINDS[value] || 'none'
    const MANAGED_DECISION_KEYS = ['kind', 'provider', 'model', 'reasoningEffort', 'credentialRef', 'baseURL', 'api', 'cacheMode', ...DECISION_NUMBERS]
    const SCHEDULER_LIMITS = {
      stateChars: { min: 100000, max: 512000, step: 1000, integer: true },
      threshold: { min: 0.05, max: 0.95, step: 0.05, integer: false },
      minGap: { min: 1, max: 999, step: 1, integer: true },
      maxGap: { min: 1, max: 999, step: 1, integer: true },
      timeoutMs: { min: 1000, max: 120000, step: 1, integer: true },
    }
    const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/
    const AUTOSAVE_DEBOUNCE_MS = 350
    // fanout grammar the Host accepts; the bare per-iteration option is gone.
    const FANOUT_FIXED = ['user_turn', 'smart', 'user_turn_end']
    /** Aggregator effort that the panel owns once `effortMode === 'fixed'`. */
    const EFFORT_MODES = ['follow', 'fixed']
    const MANAGED_REFERENCE_KEYS = [
      'id', 'label', 'provider', 'model', 'reasoningEffort', 'maxTokens',
      'enabled', 'persistent', 'continueOnStop', 'cacheScope', 'systemSuffix', 'contextWindow',
      'sessionPolicy',
    ]
    // reference.sessionPolicy (config.js SESSION_POLICIES): '' is the automatic
    // per-route policy and is saved by omitting the key, stable/rotate are kept.
    const SESSION_POLICY_VALUES = ['stable', 'rotate']
    const normalizeSessionPolicy = (value) => SESSION_POLICY_VALUES.includes(value) ? value : ''
    // Host-owned fields the panel does not edit but must not reset on save.
    const TIMEOUT_MIN = 1000
    const TIMEOUT_MAX = 1800000
    const REVIEW_TIMEOUT_DEFAULT = 60000
    const REVIEW_TIMEOUT_MAX = 120000

    /*
     * A frozen or hidden page can leave a remote call pending indefinitely
     * (the transport promise never settles even though the Host answers).
     * The catalog read is therefore bounded, and a late answer is dropped.
     */
    let catalogTimeoutMs = 15000

    const LOCALES = {
      zh: {
        nav: 'Better MoA',
        title: 'Better MoA 设置',
        intro: '预设表由你维护：预设、参考模型和聚合器都可增删改名。保存只写入 Host 设置，不会发起模型调用。',
        loading: '正在读取 MoA 设置…',
        unavailable: 'Host settings 尚未提供 better-moa。请确认插件已加载、配置支持实时设置并完成重载。',
        retry: '重试',
        reload: '重新读取',
        refreshCatalog: '刷新模型目录',
        save: '保存',
        saving: '保存中…',
        dirty: '有未保存更改',
        clean: '已与 Host 设置同步',
        saved: '已保存并核对 Host 返回值。',
        savedByHost: '已由 Host 设置广播核对保存。',
        awaiting: '已提交，等待 Host 确认…',
        awaitingDetail: 'Host 尚未确认写入；草稿已保留，可稍后重新读取核对。',
        saveFailed: '保存失败',
        loadFailed: '读取失败',
        external: 'Host 设置已被其他页面更新。为避免覆盖，请重新读取后再编辑。',
        notWritable: '当前 Host 设置不可写。',
        catalogFailed: '模型目录读取失败；已保存的路由仍会保留，可手动输入或刷新目录。',
        catalogTimeout: '读取模型目录超时（页面可能处于后台或已冻结）；已保存的路由仍会保留，请刷新目录重试。',
        catalogFailures: '部分 Provider 的模型目录读取失败。',
        catalogEmpty: '模型目录为空，可手动输入 provider/model。',
        catalogManual: '目录未就绪时手动输入；刷新目录后会改用完整选择列表。',
        catalogLoading: '正在读取模型目录…',
        routeStale: '此路由不在当前模型目录中，仍会原样保留；保存不会静默替换。',
        notInCatalog: '目录中未列出',
        selectProvider: '选择 Provider',
        selectModel: '选择 Model',
        selectProviderFirst: '请先选择 Provider',
        commonTitle: '全局',
        enabled: '启用 Better MoA',
        defaultPreset: '默认预设',
        defaultPresetHint: '会话默认使用的预设；只能选择已启用的预设。',
        noDefault: '暂无可用预设',
        noEnabledPresets: '当前没有启用的预设；请启用一个或删除全部预设。',
        guardEnabled: '参考输出检查',
        guardHint: '按实际规则检查参考输出：隔离伪造的工具记录与执行声称，不替代完整的提示注入防护。',
        commonAdvanced: '全局高级选项',
        editPreset: '当前编辑的预设',
        editPresetHint: '切换只改变编辑对象，不会改变默认预设或当前会话模型。',
        sharedSchedulerHint: '判断器与阈值统一在上方通用设置中配置。',
        reviewTimeoutMs: '结束前审阅超时（ms）',
        reviewTimeoutHint: '仅用于“每轮会话开始和结束”的结束前审阅；1000–120000 ms，默认 60000 ms，留空恢复默认。',
        fixedNote: '所有参考始终并行发起请求，界面不再提供并发、排队或调度模式。Host 统一限制：单参考默认 600 秒、参考阶段截止默认 900 秒（1–1800 秒，不含聚合器）。',
        presetsTitle: '预设',
        presetsIntro: '预设 id 创建后保持稳定；保存写入完整预设表，未在界面展示的提示词等高级字段会原样保留。',
        presetsEmpty: '还没有预设。新增一个预设，添加参考模型并选择聚合器后即可保存。',
        addPreset: '新增预设',
        presetName: '预设名称',
        presetDescription: '描述（可选）',
        presetDescriptionHint: '仅用于展示，不影响调用。',
        presetEnabled: '启用',
        setDefault: '设为默认',
        defaultBadge: '默认',
        deletePreset: '删除预设',
        confirmDelete: '确认删除？',
        cancelDelete: '取消',
        lastPreset: '至少保留一个启用的预设；要清空配置请删除全部预设。',
        fanout: '咨询节奏',
        user_turn: '每轮会话开始',
        smart: '智能参考调度',
        user_turn_end: '每轮会话开始和结束',
        every_n: '每 N 轮工具迭代',
        fanoutN: 'N',
        fanoutHint: '参考模型何时被调用：每轮开始；每 N 轮工具迭代；智能调度（由小模型或 JEV 判断阶段完成时介入）；每轮开始和结束（结束前再审阅一次，主模型据此修改一轮）。',
        aggregator: '聚合器',
        aggregatorEffort: '聚合器 reasoningEffort',
        followPicker: '跟随会话模型选择框',
        aggregatorEffortHint: '跟随 = 不指定，沿用会话模型选择框的 effort；选择具体档位会固定写入聚合器。',
        aggregatorEffortUnsupported: '当前聚合器模型未公开 reasoning effort，只能跟随会话模型选择框。',
        aggregatorEffortUnknown: '当前聚合器路由不在模型目录中，无法确认支持的 effort；跟随不受影响，选择具体档位前请先刷新目录。',
        schedulerTitle: '调度判断器（所有预设共用）',
        schedulerHint: '在每次工具迭代后，用便宜的模型判断是否刚完成一个小阶段；判断失败时按最长间隔兜底。',
        schedulerKind: '判断方式',
        schedulerKindModel: '小模型',
        schedulerKindJev: 'JEV 决策模型',
        schedulerKindDecisions: 'OpenAI Decisions（GPT 6 Luna）',
        schedulerKindOpenai: 'GPT 6 Luna（OpenAI Responses）',
        schedulerOpenaiHint: '两种 OpenAI 方式共用下面的环境变量。Decisions 返回介入概率；Responses 返回结构化判断。',
        schedulerCacheMode: 'OpenAI 输入缓存',
        schedulerCacheExplicit: '显式断点（推荐）',
        schedulerCacheImplicit: '服务端自动断点',
        schedulerCacheHint: '30 分钟缓存；共享前缀至少 1024 tokens 才可命中。历史窗口移动或改写会降低命中率。',
        schedulerJevCacheHint: 'JEV 暂未公开缓存断点和命中计数，不能显示可靠的命中率。',
        schedulerEnvInvalid: '请输入有效的环境变量名，不要填写密钥。',
        schedulerApiKeyEnv: 'API Key 环境变量',
        schedulerApiKeyEnvHint: '只填环境变量名，不要填密钥本身',
        schedulerJevModel: 'JEV 模型名',
        schedulerJevModelHint: '决策模型名；默认 jev-latest。',
        schedulerThreshold: '介入阈值',
        schedulerThresholdHint: '0.05–0.95，越接近 1 越少介入。',
        schedulerMinGap: '最少间隔（工具迭代）',
        schedulerMaxGap: '最长间隔（强制介入）',
        schedulerGapHint: '1–999 轮工具迭代；判断失败时到最长间隔强制介入。',
        schedulerStateChars: '判断上下文容量（字符）',
        schedulerStateCharsHint: '100000–512000，默认 128000。保留早期背景、当前用户要求和近期记录；按区间轮换。字符数不等于 token 数，长输入会增加费用和延迟。',
        schedulerTimeoutMs: '判断超时 ms',
        schedulerTimeoutHint: '1000–120000 ms；超时按“暂不介入”处理。',
        schedulerRouteRequired: '智能调度的小模型必须填写 provider/model',
        schedulerGapInvalid: '智能调度的最少间隔不能大于最长间隔',
        references: '参考模型',
        addReference: '新增参考',
        noReferences: '没有参考模型；该预设会直接由聚合器回答。',
        referenceName: '参考名称',
        removeReference: '删除',
        referenceEnabled: '启用此参考',
        injection: '参考注入方式',
        injectionSerial: '串行：等待该参考意见后继续',
        injectionParallel: '并行：主循环继续，意见下一步注入',
        injectionHint: '只决定意见何时进入主对话；所有参考始终同时并行发起请求，二者不是同一层。',
        provider: 'Provider',
        model: 'Model',
        effort: 'reasoningEffort（可选）',
        effortDefault: '模型默认',
        defaultEffort: '模型默认 effort',
        effortUnsupported: '该模型未公开 reasoning effort；保存时不会发送已存的值。',
        effortUnknown: '该路由不在目录中，无法确认支持的 effort；原值会保留。',
        maxTokens: 'maxTokens（可选）',
        maxTokensHint: '留空 = 使用模型默认值；面板不套用固定通用上限，仅在填写时要求正整数。',
        advancedOptions: '高级选项（可选）',
        advancedHint: '以下字段通常无需修改；留空表示沿用 Host 默认。',
        referencePersistent: '持久化',
        autoPersistent: '自动（沿用 Host）',
        autoContinueOnStop: '自动（沿用 Host）',
        referenceContinueOnStop: '停止时继续',
        persistentHint: '是否把该参考的检查点持久化；自动表示沿用 Host 策略。',
        continueOnStop: '会话停止时是否继续执行；自动表示沿用 Host 策略。',
        cacheScope: '缓存 scope',
        cacheScopeHint: '标记参考请求的缓存范围；留空表示不指定。',
        systemSuffix: '系统后缀',
        systemSuffixHint: '追加到该参考系统提示的词条；留空表示不追加。',
        sessionPolicy: '会话缓存策略',
        'sessionPolicy_auto': '自动（按路由）',
        'sessionPolicy_stable': '稳定',
        'sessionPolicy_rotate': '轮换',
        sessionPolicyHint: '稳定：上下文重建后仍复用同一会话 id，缓存命中更多；轮换：每次重建换新会话，与 0.8.0 一致；自动：按路由决定（保存时不写入该字段）。',
        auto: '自动',
        on: '开',
        off: '关',
        routeRequired: '聚合器和启用的参考必须填写 provider/model，且 provider 不能是 moa',
        defaultDisabled: '默认预设必须存在且已启用',
        noPresets: '至少启用一个预设，或删除全部预设以清空配置',
        fanoutInvalid: '咨询节奏只能是每轮开始、智能调度、每轮开始和结束，或 1–999 的每 N 轮工具迭代',
        agentEffortInvalid: '聚合器固定使用的 reasoningEffort 不在该模型支持的档位中',
        aggregatorEffortRequired: '该聚合器模型没有公布 reasoning effort，无法固定档位；请改为跟随会话模型选择框',
        maxTokensInvalid: 'maxTokens 必须留空或为正整数',
        reviewTimeoutInvalid: '结束前审阅超时必须留空或为 1000–120000 ms 的整数',
        labelRequired: '预设名称不能为空',
        invalidId: '预设或参考 id 必须是稳定的 ASCII 标识（字母/数字开头，可含 . _ -）',
        duplicateId: '预设或参考 id 不能重复',
        unverified: 'Host 已响应，但返回设置与提交值不一致；草稿已保留，请重新读取核对。',
        unknownError: '未知错误',
      },
      en: {
        nav: 'Better MoA',
        title: 'Better MoA settings',
        intro: 'You own the preset table: presets, reference models and aggregators can be added, renamed or removed. Saving writes Host settings only; it never starts a model call.',
        loading: 'Loading MoA settings…',
        unavailable: 'Host settings does not serve better-moa yet. Check that the plugin is loaded, its config supports live settings, and the client has reloaded.',
        retry: 'Retry',
        reload: 'Reload',
        refreshCatalog: 'Refresh model catalog',
        save: 'Save',
        saving: 'Saving…',
        dirty: 'Unsaved changes',
        clean: 'In sync with Host settings',
        saved: 'Saved and verified against the Host response.',
        savedByHost: 'Save confirmed by a Host settings broadcast.',
        awaiting: 'Submitted; waiting for Host confirmation…',
        awaitingDetail: 'The Host has not confirmed the write yet. Your draft is preserved; reload to verify later.',
        saveFailed: 'Save failed',
        loadFailed: 'Load failed',
        external: 'Host settings changed in another surface. Reload before editing again to avoid overwriting that change.',
        notWritable: 'The current Host settings document is read-only.',
        catalogFailed: 'The model catalog could not be loaded. Saved routes are preserved; enter them manually or refresh the catalog.',
        catalogTimeout: 'Loading the model catalog timed out (the page may be in the background or frozen). Saved routes are preserved; refresh the catalog to retry.',
        catalogFailures: 'Some providers failed to return their model catalogs.',
        catalogEmpty: 'The model catalog is empty. You can enter provider/model manually.',
        catalogManual: 'Manual input while the catalog is unavailable; refresh to get the full picker.',
        catalogLoading: 'Loading the model catalog…',
        routeStale: 'This route is not in the current catalog. It is preserved verbatim and never replaced silently.',
        notInCatalog: 'not in catalog',
        selectProvider: 'Select provider',
        selectModel: 'Select model',
        selectProviderFirst: 'Select a provider first',
        commonTitle: 'Global',
        enabled: 'Enable Better MoA',
        defaultPreset: 'Default preset',
        defaultPresetHint: 'Preset used by default in a session; only enabled presets are selectable.',
        noDefault: 'No preset available',
        noEnabledPresets: 'No preset is enabled. Enable one, or delete every preset to clear the table.',
        guardEnabled: 'Reference output check',
        guardHint: 'Applies the actual rule set to reference output: fabricated tool records and execution claims are isolated. Not a complete prompt-injection defense.',
        commonAdvanced: 'Global advanced options',
        editPreset: 'Preset to edit',
        editPresetHint: 'This only selects the editor; it does not change the default preset or the current session model.',
        sharedSchedulerHint: 'Configure the shared judge and thresholds in General settings above.',
        reviewTimeoutMs: 'End-of-turn review timeout (ms)',
        reviewTimeoutHint: 'Only for the review at the start-and-end cadence: 1000–120000 ms, 60000 ms by default. Clear to restore the default.',
        fixedNote: 'References are always dispatched in parallel; concurrency, queueing and scheduling are no longer configurable here. The Host applies one timeout for a reference (default 600 s) and a reference-phase deadline (default 900 s, 1–1800 s, aggregator excluded).',
        presetsTitle: 'Presets',
        presetsIntro: 'A preset id stays stable once created. Saving writes the complete preset table; prompt and other advanced fields that are not shown here are preserved verbatim.',
        presetsEmpty: 'No presets yet. Add one, attach reference models and choose an aggregator, then save.',
        addPreset: 'Add preset',
        presetName: 'Preset name',
        presetDescription: 'Description (optional)',
        presetDescriptionHint: 'Presentation only; does not affect calls.',
        presetEnabled: 'Enabled',
        setDefault: 'Set default',
        defaultBadge: 'Default',
        deletePreset: 'Delete preset',
        confirmDelete: 'Delete this preset?',
        cancelDelete: 'Cancel',
        lastPreset: 'Keep at least one preset enabled; delete every preset to clear the table.',
        fanout: 'Consultation cadence',
        user_turn: 'At the start of each turn',
        smart: 'Smart scheduling',
        user_turn_end: 'Start and end of each turn',
        every_n: 'Every N tool iterations',
        fanoutN: 'N',
        fanoutHint: 'When the reference models are called: at the start of each turn; every N tool iterations; smart scheduling (a small model or JEV decides when a phase is complete); start and end of each turn (one more review before the turn ends, and the main model gets one more revision round).',
        aggregator: 'Aggregator',
        aggregatorEffort: 'Aggregator reasoningEffort',
        followPicker: 'Follow the session model picker',
        aggregatorEffortHint: 'Follow means no override: the session model picker decides the effort. Picking a level pins it on the aggregator.',
        aggregatorEffortUnsupported: 'The selected aggregator model advertises no reasoning efforts, so it can only follow the session model picker.',
        aggregatorEffortUnknown: 'The aggregator route is not in the catalog, so effort support is unknown. Following is unaffected; refresh the catalog before pinning a level.',
        schedulerTitle: 'Scheduler (shared by all presets)',
        schedulerHint: 'After every tool iteration a cheap model decides whether a small phase just completed; when a judgement fails, the longest gap forces one.',
        schedulerKind: 'Judge',
        schedulerKindModel: 'Small model',
        schedulerKindJev: 'JEV decision model',
        schedulerKindDecisions: 'OpenAI Decisions (GPT 6 Luna)',
        schedulerKindOpenai: 'GPT 6 Luna (OpenAI Responses)',
        schedulerOpenaiHint: 'Both OpenAI modes share the environment variable below. Decisions returns intervention probabilities; Responses returns a structured judgement.',
        schedulerCacheMode: 'OpenAI input cache',
        schedulerCacheExplicit: 'Explicit breakpoints (recommended)',
        schedulerCacheImplicit: 'Automatic server breakpoints',
        schedulerCacheHint: '30-minute cache; a shared prefix needs at least 1024 tokens. Moving or rewriting the history window reduces reuse.',
        schedulerJevCacheHint: 'JEV does not publish cache controls or counters, so its hit rate cannot be measured reliably.',
        schedulerEnvInvalid: 'Enter a valid environment variable name, not the API key.',
        schedulerApiKeyEnv: 'API key environment variable',
        schedulerApiKeyEnvHint: 'Environment variable name only, never the key itself',
        schedulerJevModel: 'JEV model name',
        schedulerJevModelHint: 'Decision model name; jev-latest by default.',
        schedulerThreshold: 'Intervention threshold',
        schedulerThresholdHint: '0.05–0.95; the closer to 1, the less often it intervenes.',
        schedulerMinGap: 'Minimum gap (tool iterations)',
        schedulerMaxGap: 'Maximum gap (forced intervention)',
        schedulerGapHint: '1–999 tool iterations; after a failed judgement the maximum gap forces one.',
        schedulerStateChars: 'Judge context capacity (characters)',
        schedulerStateCharsHint: '100000–512000; default 128000. Retains early context, the current user request and recent records, rotating in coarse windows. Characters are not tokens; longer input costs more and may take longer.',
        schedulerTimeoutMs: 'Judgement timeout (ms)',
        schedulerTimeoutHint: '1000–120000 ms; a timeout counts as "not now".',
        schedulerRouteRequired: 'The smart-scheduling model requires provider/model',
        schedulerGapInvalid: 'The minimum gap cannot exceed the maximum gap',
        references: 'Reference models',
        addReference: 'Add reference',
        noReferences: 'No references; the aggregator answers directly for this preset.',
        referenceName: 'Reference name',
        removeReference: 'Remove',
        referenceEnabled: 'Enabled',
        injection: 'Advice injection',
        injectionSerial: 'Serial: wait for this advice, then continue',
        injectionParallel: 'Parallel: keep looping, inject at the next step',
        injectionHint: 'Only controls when advice enters the main conversation. Every reference is still dispatched in parallel; these are different layers.',
        provider: 'Provider',
        model: 'Model',
        effort: 'reasoningEffort (optional)',
        effortDefault: 'Model default',
        defaultEffort: 'Model default effort',
        effortUnsupported: 'This model does not advertise reasoning efforts; a stored value is not sent on save.',
        effortUnknown: 'This route is not in the catalog, so effort support is unknown; the stored value is preserved.',
        maxTokens: 'maxTokens (optional)',
        maxTokensHint: 'Blank = the model default; the panel applies no fixed universal cap and only requires a positive integer when set.',
        advancedOptions: 'Advanced options (optional)',
        advancedHint: 'Usually unnecessary. Blank means the Host default applies.',
        referencePersistent: 'Persistent',
        autoPersistent: 'Auto (Host policy)',
        autoContinueOnStop: 'Auto (Host policy)',
        referenceContinueOnStop: 'Continue on stop',
        persistentHint: 'Whether this reference checkpoint is persisted. Auto follows the Host policy.',
        continueOnStop: 'Whether this reference keeps running when the session stops. Auto follows the Host policy.',
        cacheScope: 'Cache scope',
        cacheScopeHint: 'Marks the cache scope of reference requests; blank means unspecified.',
        systemSuffix: 'System suffix',
        systemSuffixHint: 'Text appended to this reference’s system prompt; blank means none.',
        auto: 'Auto',
        on: 'On',
        off: 'Off',
        routeRequired: 'Aggregators and enabled references require provider/model; provider cannot be moa',
        defaultDisabled: 'The default preset must exist and be enabled',
        noPresets: 'Enable at least one preset, or delete every preset to clear the table',
        fanoutInvalid: 'The cadence must be the start of each turn, smart scheduling, the start and end of each turn, or every N tool iterations with N from 1 to 999',
        agentEffortInvalid: 'The aggregator\'s pinned reasoningEffort is not one of the levels this model advertises',
        aggregatorEffortRequired: 'This aggregator model advertises no reasoning efforts, so a level cannot be pinned; follow the session model picker instead',
        maxTokensInvalid: 'maxTokens must be blank or a positive integer',
        reviewTimeoutInvalid: 'The review timeout must be blank or an integer from 1000 to 120000 ms',
        labelRequired: 'A preset name is required',
        invalidId: 'Preset and reference ids must be stable ASCII identifiers (letter/digit first; . _ - allowed)',
        duplicateId: 'Preset and reference ids must be unique',
        unverified: 'The Host responded, but its returned settings differ from the submitted values. Your draft is preserved; reload to inspect it.',
        unknownError: 'Unknown error',
      },
    }

    Object.assign(LOCALES.zh, {
      decisionKind_none: '不使用决策模型', 'decisionKind_dsh-model': 'DSH 模型',
      'decisionKind_openai-compatible': 'OpenAI 兼容端点', decisionKind_jev: 'JEV',
      'decisionKind_openai-decisions': 'OpenAI Decisions',
      credentialValue: 'API 密钥（只写）', credentialPlaceholder: '输入新密钥；不会回显已保存值',
      credentialConfigured: '已配置', credentialNotConfigured: '尚未在 DSH 凭据存储中配置；仍可使用同名环境变量。',
      saveCredential: '保存密钥', credentialSaved: '密钥已保存。', credentialSaveFailed: '密钥保存失败',
      testConnection: '测试', testing: '测试中…', testSuccess: '连接成功，已发现模型目录。', testFailed: '连接测试失败',
      testNeedsKey: '测试已保存密钥以外的端点时，请先输入新密钥；密钥不会写入设置。', testCatalogSuccess: 'Provider/model 已在 DSH 模型目录中。',
      testCatalogFailure: 'Provider/model 不在当前 DSH 模型目录中。',
      decisionBaseURL: 'Base URL', decisionApi: 'API（可选）', decisionApiHint: '留空使用 Host 默认；仅测试时转发给 discoverModels。',
      decisionModelRequired: 'HTTP 决策模型必须填写 model 和 Base URL', decisionBaseURLInvalid: 'Base URL 必须是有效的 HTTP(S) 地址',
      noDecisionWarning: '已启用 smart 预设，但未配置决策模型：smart 节奏将只按 maxGap 强制触发。',
      confirmNoDecision: '仍有 smart 预设。停用决策模型后只按 maxGap 调度，确认继续？',
      delivery: '参考意见注入方式', deliveryWait: '等待全部参考模型（或超时）后一次注入',
      deliveryBackground: '后台收集，汇齐（或超时）后在下一步一次注入',
      presetReferenceTimeout: '参考模型超时（秒）', presetReferenceTimeoutHint: '1–1800 秒；留空使用全局值。超时参考会在单次注入中列为不可用。',
      contextWindow: '上下文窗口（tokens，可选）', contextWindowAuto: '自动', contextWindowHint: '8192–10000000；留空由目录或 billion-context 拒绝信息自动学习。',
      referenceTimeoutInvalid: '预设参考超时必须为 1–1800 秒的整数', contextWindowInvalid: '上下文窗口必须为 8192–10000000 的整数或留空',
    })
    Object.assign(LOCALES.en, {
      decisionKind_none: 'No decision model', 'decisionKind_dsh-model': 'DSH model',
      'decisionKind_openai-compatible': 'OpenAI-compatible endpoint', decisionKind_jev: 'JEV',
      'decisionKind_openai-decisions': 'OpenAI Decisions',
      credentialValue: 'API key (write-only)', credentialPlaceholder: 'Enter a new key; saved values are never echoed',
      credentialConfigured: 'Configured', credentialNotConfigured: 'Not configured in the DSH credential store; a same-named environment variable can still be used.',
      saveCredential: 'Save key', credentialSaved: 'Credential saved.', credentialSaveFailed: 'Could not save credential',
      testConnection: 'Test', testing: 'Testing…', testSuccess: 'Connection succeeded and returned a model catalog.', testFailed: 'Connection test failed',
      testNeedsKey: 'Enter a fresh key to test this endpoint. Keys are never written into settings.', testCatalogSuccess: 'Provider/model is present in the DSH model catalog.',
      testCatalogFailure: 'Provider/model is not present in the current DSH model catalog.',
      decisionBaseURL: 'Base URL', decisionApi: 'API (optional)', decisionApiHint: 'Blank uses the Host default; forwarded to discoverModels only for the test.',
      decisionModelRequired: 'HTTP decision models require model and Base URL', decisionBaseURLInvalid: 'Base URL must be a valid HTTP(S) URL',
      noDecisionWarning: 'A smart preset is enabled without a decision model: smart cadence will use maxGap-only scheduling.',
      confirmNoDecision: 'Smart presets are still enabled. Without a decision model they use maxGap-only scheduling. Continue?',
      delivery: 'Reference injection', deliveryWait: 'Wait for all references (or timeout), then inject once',
      deliveryBackground: 'Collect in background; inject once at the next step when complete (or timed out)',
      presetReferenceTimeout: 'Reference timeout (seconds)', presetReferenceTimeoutHint: 'Integer 1–1800 seconds; blank inherits the global value. Timed-out references are listed as unavailable in the single injection.',
      contextWindow: 'Context window (tokens, optional)', contextWindowAuto: 'Automatic', contextWindowHint: '8192–10000000; blank uses the catalog or values learned from billion-context refusals.',
      sessionPolicy: 'Session cache policy',
      'sessionPolicy_auto': 'Auto (by route)',
      'sessionPolicy_stable': 'Stable',
      'sessionPolicy_rotate': 'Rotate',
      sessionPolicyHint: 'Stable reuses one session id after a context rebuild (more cache hits); Rotate starts a fresh session per rebuild, matching 0.8.0; Auto follows the route and is saved by omitting the field.',
      referenceTimeoutInvalid: 'Preset reference timeout must be an integer from 1 to 1800 seconds', contextWindowInvalid: 'Context window must be blank or an integer from 8192 to 10000000',
    })

    const CSS = `
.dsh-moa-advice{box-sizing:border-box;max-width:100%;border:1px solid var(--dsw-alias-border-l3);border-left:3px solid var(--dsw-alias-state-warn-label);border-radius:var(--dsw-radius-md);padding:10px 12px;margin:6px 0;background:var(--dsw-alias-settings-card-fill);color:var(--dsw-alias-label-primary)}
.dsh-moa-advice-header{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.dsh-moa-advice-preset{font:12px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsw-alias-label-tertiary)}
.dsh-moa-advice-toggle{min-height:28px;padding:3px 8px;font-size:12px}.dsh-moa-advice .dsh-moa-note{margin:5px 0;font-size:12px}.dsh-moa-advice-text{white-space:pre-wrap;overflow-wrap:anywhere;max-height:420px;overflow:auto;margin:8px 0 0;font:13px/1.6 inherit}
.dsh-moa-section{box-sizing:border-box;max-width:880px;margin:0 auto;padding:20px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px;font-size:14px;line-height:1.5}
.dsh-moa-section *{box-sizing:border-box}.dsh-moa-title{margin:0;font-size:20px;font-weight:600}.dsh-moa-intro,.dsh-moa-note{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px}
.dsh-moa-card{border:1px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);border-radius:var(--dsw-radius-xl);padding:14px;display:flex;flex-direction:column;gap:12px}
.dsh-moa-card-title{margin:0;font-size:15px;font-weight:600}.dsh-moa-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px}
.dsh-moa-field{display:flex;flex-direction:column;gap:5px;min-width:0}.dsh-moa-field>span,.dsh-moa-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-moa-input,.dsh-moa-select{width:100%;min-height:34px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-settings-card-fill);color:var(--dsw-alias-label-primary);padding:6px 9px;font:inherit}
.dsh-moa-input:focus,.dsh-moa-select:focus,.dsh-moa-button:focus-visible,.dsh-moa-advanced summary:focus-visible{outline:2px solid var(--dsw-alias-state-success-primary);outline-offset:1px}
.dsh-moa-check{display:flex;align-items:center;gap:8px;min-height:32px}.dsh-moa-check input{width:16px;height:16px;margin:0}
.dsh-moa-disabled{opacity:.58}
.dsh-moa-button{border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-settings-card-fill);color:var(--dsw-alias-label-primary);min-height:34px;padding:6px 12px;font:inherit;cursor:pointer}
.dsh-moa-button:disabled{cursor:not-allowed;opacity:.5}.dsh-moa-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-settings-card-fill);border-color:transparent}
.dsh-moa-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.dsh-moa-spacer{flex:1}.dsh-moa-fields{border:0;padding:0;margin:0;min-width:0;display:flex;flex-direction:column;gap:14px}
.dsh-moa-preset-name{flex:1 1 220px;font-weight:600}.dsh-moa-ref-name{flex:1 1 160px}
.dsh-moa-status{font-size:13px;color:var(--dsw-alias-label-secondary)}.dsh-moa-dirty{color:var(--dsw-alias-state-warn-label)}.dsh-moa-saved{color:var(--dsw-alias-state-success-primary)}.dsh-moa-badge{display:inline-flex;align-items:center;white-space:nowrap;padding:2px 7px;border-radius:999px;background:var(--dsw-alias-bg-success-secondary);color:var(--dsw-alias-state-success-primary);font-size:12px}
.dsh-moa-error{margin:0;padding:9px 11px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-state-error-primary);font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-moa-warning{margin:0;color:var(--dsw-alias-state-warn-label);font-size:12px}.dsh-moa-follow{display:inline-flex;align-items:center;min-height:34px;padding:5px 9px;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-secondary)}
.dsh-moa-reference{border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);padding:12px;display:flex;flex-direction:column;gap:10px}
.dsh-moa-reference-title{margin:0;font-size:13px;font-weight:600}
.dsh-moa-advanced{border-top:1px dashed var(--dsw-alias-border-l3);padding-top:8px}.dsh-moa-advanced summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-moa-advanced[open]{display:flex;flex-direction:column;gap:10px}
.dsh-moa-empty{border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);padding:14px;display:flex;flex-direction:column;gap:10px}
.dsh-moa-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.dsh-moa-footer{position:sticky;bottom:0;padding:10px 0;background:var(--dsw-alias-settings-card-fill)}
@media(max-width:600px){.dsh-moa-section{padding:12px}.dsh-moa-grid{grid-template-columns:1fr}.dsh-moa-footer{position:static}}
`

    function isRecord(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    function clone(value) {
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
    }

    function text(value, fallback = '') {
      return typeof value === 'string' ? value.trim() : fallback
    }

    function sameJson(left, right) {
      return JSON.stringify(left) === JSON.stringify(right)
    }

    /** Copy every key this panel does not own so a save cannot drop Host data. */
    function extrasOf(value, managed) {
      const output = {}
      for (const [key, entry] of Object.entries(isRecord(value) ? value : {})) {
        if (!managed.includes(key)) output[key] = clone(entry)
      }
      return output
    }

    function asciiSlug(value) {
      return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
    }

    function uniqueId(seedList, label, prefix) {
      const used = new Set(seedList.map((entry) => entry.id))
      const base = asciiSlug(label) || prefix
      let candidate = base
      let suffix = 2
      while (used.has(candidate)) {
        candidate = `${base}-${suffix}`
        suffix += 1
      }
      return candidate
    }

    function nextPresetId(presets, label) {
      return uniqueId(presets, label, 'preset')
    }

    function nextReferenceId(references, label) {
      return uniqueId(references, label, 'ref')
    }

    function normalizeFanout(value) {
      const fanout = String(value || 'user_turn').trim().toLowerCase()
      // Legacy spelling of every_n:1: same Host behaviour, one option only.
      if (fanout === 'per_iteration') return 'every_n:1'
      if (FANOUT_FIXED.includes(fanout)) return fanout
      const match = /^every_n:(\d+)$/.exec(fanout)
      if (!match) return 'user_turn'
      const count = Number(match[1])
      if (!Number.isFinite(count) || count < 1) return 'every_n:1'
      return `every_n:${Math.min(Math.floor(count), FANOUT_MAX)}`
    }

    function fanoutMode(fanout) {
      return /^every_n:/.test(fanout) ? 'every_n' : fanout
    }

    function fanoutCount(fanout) {
      const match = /^every_n:(\d+)$/.exec(String(fanout || ''))
      return match ? Number(match[1]) : undefined
    }

    function normalizeTimeout(value) {
      return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
        && value >= TIMEOUT_MIN && value <= TIMEOUT_MAX ? value : ''
    }

    /**
     * Aggregator effort. `effortMode: 'follow'` means "the session model picker
     * decides"; only `'fixed'` makes `reasoningEffort` authoritative on the
     * Host. Presets written before this mode existed carry a bare
     * reasoningEffort (often 'max') and no mode, so absence MUST read as follow
     * and the value must ride along untouched.
     */
    function normalizeEffortMode(value) {
      const mode = String(value || '').trim().toLowerCase()
      return EFFORT_MODES.includes(mode) ? mode : 'follow'
    }

    function decisionNumber(raw, name) {
      const value = Number(raw[name])
      if (!Number.isFinite(value)) return DECISION_DEFAULTS[name]
      const limit = SCHEDULER_LIMITS[name]
      if (name === 'stateChars' && value < limit.min) return DECISION_DEFAULTS[name]
      const clamped = Math.min(limit.max, Math.max(limit.min, value))
      return limit.integer ? Math.floor(clamped) : clamped
    }

    function normalizeDecisionDraft(raw) {
      const value = isRecord(raw) ? raw : {}
      const kind = decisionKind(String(value.kind || 'none').trim().toLowerCase())
      const jev = kind === 'jev'
      const openai = kind === 'openai-decisions'
      const compatible = kind === 'openai-compatible'
      const decision = {
        kind,
        provider: text(value.provider),
        model: text(value.model || (jev ? value.jevModel : '') || (openai ? 'gpt-6-luna' : jev ? 'jev-latest' : '')),
        reasoningEffort: text(value.reasoningEffort),
        credentialRef: text(value.credentialRef || (jev ? value.apiKeyEnv : value.openaiApiKeyEnv)
          || (jev ? 'TYPESAFE_API_KEY' : compatible ? 'BETTER_MOA_DECISION_API_KEY' : 'MOA_OPENAI_API_KEY')),
        baseURL: text(value.baseURL || (jev ? value.jevBaseURL : value.openaiBaseURL)
          || (jev ? 'https://api.typesafe.ai/v1/systemone' : 'https://api.openai.com/v1')),
        api: OPENAI_COMPATIBLE_APIS.includes(value.api || value.openaiApi) ? (value.api || value.openaiApi) : '',
        cacheMode: value.cacheMode === 'implicit' || value.openaiCacheMode === 'implicit' ? 'implicit' : 'explicit',
        threshold: decisionNumber(value, 'threshold'), minGap: decisionNumber(value, 'minGap'),
        maxGap: decisionNumber(value, 'maxGap'), timeoutMs: decisionNumber(value, 'timeoutMs'),
        stateChars: decisionNumber(value, 'stateChars'),
        extra: extrasOf(value, [...MANAGED_DECISION_KEYS, 'apiKeyEnv', 'openaiApiKeyEnv', 'jevModel', 'jevBaseURL', 'openaiModel', 'openaiBaseURL', 'openaiApi', 'openaiCacheMode']),
      }
      return decision
    }

    function normalizeReferenceDraft(raw, index) {
      const value = isRecord(raw) ? raw : {}
      const maxTokens = typeof value.maxTokens === 'number' && Number.isFinite(value.maxTokens)
        && Number.isInteger(value.maxTokens) && value.maxTokens > 0 ? value.maxTokens : ''
      return {
        id: text(value.id) || `ref-${index + 1}`,
        label: text(value.label),
        provider: text(value.provider),
        model: text(value.model),
        reasoningEffort: text(value.reasoningEffort),
        maxTokens,
        contextWindow: typeof value.contextWindow === 'number' && Number.isInteger(value.contextWindow) ? value.contextWindow : '',
        enabled: value.enabled !== false,
        persistent: typeof value.persistent === 'boolean' ? value.persistent : '',
        continueOnStop: typeof value.continueOnStop === 'boolean' ? value.continueOnStop : '',
        cacheScope: text(value.cacheScope),
        systemSuffix: text(value.systemSuffix),
        sessionPolicy: normalizeSessionPolicy(value.sessionPolicy),
        // timeoutMs and future fields round-trip; legacy async is deliberately retired.
        extra: extrasOf(value, [...MANAGED_REFERENCE_KEYS, 'async']),
      }
    }

    function normalizePresetDraft(id, raw, enabled) {
      const value = isRecord(raw) ? raw : {}
      const aggregator = isRecord(value.aggregator) ? value.aggregator : {}
      return {
        id,
        label: text(value.label),
        description: text(value.description),
        fanout: normalizeFanout(value.fanout),
        delivery: value.delivery === 'background' || value.delivery === 'wait' ? value.delivery
          : (Array.isArray(value.references) && value.references.some(ref => ref?.enabled !== false)
            && value.references.filter(ref => ref?.enabled !== false).every(ref => ref?.async === true) ? 'background' : 'wait'),
        referenceTimeoutMs: normalizeTimeout(value.referenceTimeoutMs),
        aggregator: {
          provider: text(aggregator.provider),
          model: text(aggregator.model),
          effortMode: normalizeEffortMode(aggregator.effortMode),
          // Kept even under follow: it rides along and only becomes effective
          // once the user pins a level (or the Host sees effortMode: 'fixed').
          reasoningEffort: text(aggregator.reasoningEffort),
          extra: extrasOf(aggregator, MANAGED_AGGREGATOR_KEYS),
        },
        // null = no managed scheduler; the stored value is left alone on save.
        scheduler: null, // Legacy values migrate into the shared draft below.
        references: Array.isArray(value.references)
          ? value.references.map((reference, index) => normalizeReferenceDraft(reference, index))
          : [],
        enabled: enabled !== false,
        extra: extrasOf(value, MANAGED_PRESET_KEYS),
      }
    }

    /**
     * Read the Host document. presetOverrides is the complete user-owned table:
     * there is no built-in preset list and no fallback expansion here.
     */
    function draftFromValue(raw) {
      const input = isRecord(raw) ? raw : {}
      const overrides = isRecord(input.presetOverrides) ? input.presetOverrides : {}
      const disabled = new Set(Array.isArray(input.disabledPresets)
        ? input.disabledPresets.filter((id) => typeof id === 'string') : [])
      const presets = []
      for (const [id, entry] of Object.entries(overrides)) {
        if (!text(id) || !isRecord(entry)) continue
        presets.push(normalizePresetDraft(id, entry, !disabled.has(id)))
      }
      const enabledIds = presets.filter((preset) => preset.enabled).map((preset) => preset.id)
      let defaultPreset = text(input.defaultPreset)
      if (!presets.length) defaultPreset = ''
      else if (!enabledIds.includes(defaultPreset)) defaultPreset = enabledIds[0] || ''
      const legacyScheduler = overrides[defaultPreset]?.scheduler
        || enabledIds.map(id => overrides[id]).find(preset => preset.fanout === 'smart' && isRecord(preset.scheduler))?.scheduler
        || Object.values(overrides).find(preset => isRecord(preset?.scheduler))?.scheduler
      const decision = normalizeDecisionDraft(isRecord(input.decision) ? input.decision : isRecord(input.scheduler) ? input.scheduler : legacyScheduler)
      return {
        enabled: typeof input.enabled === 'boolean' ? input.enabled : true,
        guardEnabled: typeof input.guardEnabled === 'boolean' ? input.guardEnabled : true,
        defaultPreset,
        presets,
        decision,
        // Match the Host's effective value; an empty edited field restores its default.
        reviewTimeoutMs: typeof input.reviewTimeoutMs === 'number' && Number.isFinite(input.reviewTimeoutMs)
          ? Math.min(REVIEW_TIMEOUT_MAX, Math.max(TIMEOUT_MIN, Math.floor(input.reviewTimeoutMs)))
          : REVIEW_TIMEOUT_DEFAULT,
        // Host-owned values the panel does not expose anymore. Empty string /
        // null means "absent"; a save then omits the key instead of inventing one.
        persistentTags: Array.isArray(input.persistentTags) ? input.persistentTags.map((tag) => String(tag)) : null,
        referenceTimeoutMs: normalizeTimeout(input.referenceTimeoutMs),
        deadlineMs: normalizeTimeout(input.deadlineMs),
      }
    }

    function draftSignature(draft) {
      // Clearing the review field saves the default. Its Host echo must also
      // confirm that draft rather than leave an already saved reset dirty.
      return JSON.stringify(draft?.reviewTimeoutMs === ''
        ? { ...draft, reviewTimeoutMs: REVIEW_TIMEOUT_DEFAULT } : draft)
    }

    function validRoute(route) {
      return isRecord(route) && text(route.provider) !== '' && text(route.provider) !== 'moa' && text(route.model) !== ''
    }

    function validId(value) {
      return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(text(value))
    }

    /** Range check for one scheduler number; returns an error code or undefined. */
    function schedulerRangeError(name, value) {
      const limit = SCHEDULER_LIMITS[name]
      const normalized = value === '' || value === undefined ? DECISION_DEFAULTS[name] : value
      if (typeof normalized !== 'number' || !Number.isFinite(normalized)) return 'schedulerInvalid'
      if (limit.integer && !Number.isInteger(normalized)) return 'schedulerInvalid'
      return normalized < limit.min || normalized > limit.max ? 'schedulerInvalid' : undefined
    }

    function validateDecision(decision) {
      const value = isRecord(decision) ? decision : emptyDecisionDraft()
      const kind = decisionKind(value.kind)
      if (kind === 'dsh-model' && !validRoute(value)) {
        return { type: 'validation', code: 'schedulerRouteRequired', field: 'decision.model' }
      }
      if (kind !== 'none' && kind !== 'dsh-model') {
        if (!text(value.model) || !text(value.baseURL)) return { type: 'validation', code: 'decisionModelRequired', field: 'decision.model' }
        if (!/^https?:\/\/\S+$/i.test(text(value.baseURL))) return { type: 'validation', code: 'decisionBaseURLInvalid', field: 'decision.baseURL' }
        if (!CREDENTIAL_REF.test(text(value.credentialRef))) return { type: 'validation', code: 'schedulerEnvInvalid', field: 'decision.credentialRef' }
      }
      for (const name of DECISION_NUMBERS) {
        const code = schedulerRangeError(name, value[name])
        if (code) return { type: 'validation', code, field: `decision.${name}`, min: SCHEDULER_LIMITS[name].min, max: SCHEDULER_LIMITS[name].max }
      }
      if (value.minGap > value.maxGap) return { type: 'validation', code: 'schedulerGapInvalid', field: 'decision.maxGap' }
      return undefined
    }

    /**
     * A pinned aggregator effort must exist on the chosen model. Only judged
     * when the catalog KNOWS the model advertises efforts; an unknown route
     * cannot be checked, and follow never validates the carried value.
     */
    function validateAggregatorEffort(preset, id, catalog) {
      const aggregator = preset.aggregator
      if (!isRecord(aggregator) || normalizeEffortMode(aggregator.effortMode) !== 'fixed') return undefined
      const effort = text(aggregator.reasoningEffort)
      if (!effort) return undefined
      const support = effortSupport(findModel(catalog, aggregator.provider, aggregator.model))
      if (support === 'unsupported') {
        return { type: 'validation', code: 'aggregatorEffortRequired', field: `${id}.aggregator.reasoningEffort` }
      }
      if (support !== 'supported') return undefined
      return modelEfforts(catalog, aggregator.provider, aggregator.model).includes(effort)
        ? undefined
        : { type: 'validation', code: 'agentEffortInvalid', field: `${id}.aggregator.reasoningEffort` }
    }

    /**
     * Effort ids advertised for a route. The catalog publishes either bare
     * strings or `{ id, name }` entries, so both are normalised to ids.
     */
    function modelEfforts(catalog, provider, model) {
      const entry = findModel(catalog, provider, model)
      const efforts = entry && entry.reasoning && Array.isArray(entry.reasoning.efforts) ? entry.reasoning.efforts : []
      return efforts.flatMap((effort) => {
        if (typeof effort === 'string') return [effort]
        return isRecord(effort) && text(effort.id) ? [effort.id] : []
      })
    }

    /** Return a machine-readable validation error, or undefined for a saveable draft. */
    function validateDraft(draft, catalog) {
      if (!isRecord(draft) || !Array.isArray(draft.presets)) return { type: 'validation', code: 'routeRequired' }
      const reviewTimeoutMs = draft.reviewTimeoutMs === '' ? REVIEW_TIMEOUT_DEFAULT : draft.reviewTimeoutMs
      if (typeof reviewTimeoutMs !== 'number' || !Number.isFinite(reviewTimeoutMs) || !Number.isInteger(reviewTimeoutMs)
        || reviewTimeoutMs < TIMEOUT_MIN || reviewTimeoutMs > REVIEW_TIMEOUT_MAX) {
        return { type: 'validation', code: 'reviewTimeoutInvalid', field: 'reviewTimeoutMs', min: TIMEOUT_MIN, max: REVIEW_TIMEOUT_MAX }
      }
      const decisionFailure = validateDecision(draft.decision)
      if (decisionFailure) return decisionFailure
      const presetIds = new Set()
      for (const [index, preset] of draft.presets.entries()) {
        if (!isRecord(preset)) return { type: 'validation', code: 'routeRequired', field: `presets.${index}` }
        const id = text(preset.id)
        if (!validId(id)) return { type: 'validation', code: 'invalidId', field: `presets.${index}.id` }
        if (presetIds.has(id)) return { type: 'validation', code: 'duplicateId', field: `presets.${index}.id` }
        presetIds.add(id)
        if (!text(preset.label)) return { type: 'validation', code: 'labelRequired', field: `${id}.label` }
        const match = fanoutCount(preset.fanout)
        if (!['user_turn', 'smart', 'user_turn_end'].includes(preset.fanout)
          && (match === undefined || !Number.isInteger(match) || match < 1 || match > FANOUT_MAX)) {
          return { type: 'validation', code: 'fanoutInvalid', field: `${id}.fanout` }
        }
        if (!validRoute(preset.aggregator)) return { type: 'validation', code: 'routeRequired', field: `${id}.aggregator` }
        if (preset.referenceTimeoutMs !== '' && (!Number.isInteger(preset.referenceTimeoutMs)
          || preset.referenceTimeoutMs < 1000 || preset.referenceTimeoutMs > 1800000)) {
          return { type: 'validation', code: 'referenceTimeoutInvalid', field: `${id}.referenceTimeoutMs`, min: 1, max: 1800 }
        }
        const effortFailure = validateAggregatorEffort(preset, id, catalog)
        if (effortFailure) return effortFailure
        const referenceIds = new Set()
        for (const [referenceIndex, reference] of (preset.references || []).entries()) {
          const referenceId = text(reference?.id)
          if (!validId(referenceId)) {
            return { type: 'validation', code: 'invalidId', field: `${id}.references.${referenceIndex}.id` }
          }
          if (referenceIds.has(referenceId)) {
            return { type: 'validation', code: 'duplicateId', field: `${id}.references.${referenceIndex}.id` }
          }
          referenceIds.add(referenceId)
          if (reference.enabled !== false && !validRoute(reference)) {
            return { type: 'validation', code: 'routeRequired', field: `${id}.references.${referenceIndex}` }
          }
          if (reference.maxTokens !== '' && (typeof reference.maxTokens !== 'number' || !Number.isFinite(reference.maxTokens)
            || !Number.isInteger(reference.maxTokens) || reference.maxTokens <= 0)) {
            return { type: 'validation', code: 'maxTokensInvalid', field: `${id}.references.${referenceIndex}.maxTokens` }
          }
          if (reference.contextWindow !== '' && (!Number.isInteger(reference.contextWindow)
            || reference.contextWindow < 8192 || reference.contextWindow > 10000000)) {
            return { type: 'validation', code: 'contextWindowInvalid', field: `${id}.references.${referenceIndex}.contextWindow`, min: 8192, max: 10000000 }
          }
        }
      }
      const enabledIds = draft.presets.filter((preset) => preset.enabled !== false).map((preset) => preset.id)
      if (draft.presets.length && !enabledIds.length) return { type: 'validation', code: 'noPresets' }
      if (draft.presets.length && !enabledIds.includes(draft.defaultPreset)) {
        return { type: 'validation', code: 'defaultDisabled', field: 'defaultPreset' }
      }
      if (!draft.presets.length && text(draft.defaultPreset) !== '') {
        return { type: 'validation', code: 'defaultDisabled', field: 'defaultPreset' }
      }
      return undefined
    }

    function normalizeCatalogGroups(raw) {
      if (!Array.isArray(raw)) return []
      return raw.flatMap((group) => {
        if (!isRecord(group) || !text(group.id)) return []
        const models = Array.isArray(group.models) ? group.models.flatMap((model) => {
          if (!isRecord(model) || !text(model.id)) return []
          return [{
            id: model.id,
            name: text(model.name, model.id),
            ...(text(model.description) ? { description: text(model.description) } : {}),
            ...(isRecord(model.reasoning) ? { reasoning: clone(model.reasoning) } : {}),
          }]
        }) : []
        return [{ id: group.id, name: text(group.name, group.id), models }]
      })
    }

    function catalogGroups(catalog) {
      return catalog && Array.isArray(catalog.groups) ? catalog.groups : []
    }

    function isMoaRoute(provider, model) {
      return provider === 'moa' || /^moa[\/:]/.test(text(model))
    }

    /** Catalog view for selectors: the MoA virtual models never advise themselves. */
    function selectableGroups(catalog) {
      return catalogGroups(catalog)
        .filter((group) => group.id !== 'moa')
        .map((group) => ({
          ...group,
          models: (group.models || []).filter((model) => !isMoaRoute(group.id, model.id)),
        }))
    }

    function findModel(catalog, provider, model) {
      return catalogGroups(catalog)
        .find((group) => group.id === provider)?.models.find((entry) => entry.id === model)
    }

    /**
     * 'supported' = the catalog advertises efforts for this model,
     * 'unsupported' = the model is known but advertises none,
     * 'unknown' = the route is not in the catalog, so we cannot judge.
     */
    function effortSupport(model) {
      if (!model) return 'unknown'
      const efforts = model.reasoning && Array.isArray(model.reasoning.efforts) ? model.reasoning.efforts : []
      return efforts.length ? 'supported' : 'unsupported'
    }

    function buildReference(reference, index, catalog) {
      const effort = text(reference.reasoningEffort)
      const support = effortSupport(findModel(catalog, reference.provider, reference.model))
      return {
        ...(reference.extra || {}),
        id: text(reference.id, `ref-${index + 1}`),
        ...(text(reference.label) ? { label: text(reference.label) } : {}),
        provider: text(reference.provider),
        model: text(reference.model),
        // A model that publishes no efforts must not receive an effort value;
        // unknown routes keep the saved value rather than guessing support.
        ...(effort && support !== 'unsupported' ? { reasoningEffort: effort } : {}),
        ...(reference.maxTokens === '' ? {} : { maxTokens: reference.maxTokens }),
        ...(reference.contextWindow === '' ? {} : { contextWindow: reference.contextWindow }),
        ...(typeof reference.persistent === 'boolean' ? { persistent: reference.persistent } : {}),
        ...(typeof reference.continueOnStop === 'boolean' ? { continueOnStop: reference.continueOnStop } : {}),
        ...(text(reference.cacheScope) ? { cacheScope: text(reference.cacheScope) } : {}),
        ...(text(reference.systemSuffix) ? { systemSuffix: text(reference.systemSuffix) } : {}),
        // Automatic is the absent key; only the exact literals are written.
        ...(normalizeSessionPolicy(reference.sessionPolicy) ? { sessionPolicy: normalizeSessionPolicy(reference.sessionPolicy) } : {}),
        enabled: reference.enabled !== false,
      }
    }

    /**
     * Aggregator object. effortMode is always written (so the Host never has to
     * infer it), while reasoningEffort is written only when a value exists: a
     * follow preset keeps its carried value byte-for-byte and never gains
     * `effortMode: 'fixed'` just by being loaded and saved.
     */
    function buildAggregator(aggregator) {
      const effortMode = normalizeEffortMode(aggregator.effortMode)
      const effort = text(aggregator.reasoningEffort)
      return {
        ...(aggregator.extra || {}),
        provider: text(aggregator.provider),
        model: text(aggregator.model),
        effortMode,
        ...(effort ? { reasoningEffort: effort } : {}),
      }
    }

    function buildDecision(draft) {
      const value = isRecord(draft) ? draft : emptyDecisionDraft()
      const kind = decisionKind(value.kind)
      const shared = {
        ...(value.extra || {}), kind,
        threshold: value.threshold, minGap: value.minGap, maxGap: value.maxGap,
        timeoutMs: value.timeoutMs, stateChars: value.stateChars,
      }
      if (kind === 'none') return shared
      if (kind === 'dsh-model') return { ...shared, provider: text(value.provider), model: text(value.model),
        ...(text(value.reasoningEffort) ? { reasoningEffort: text(value.reasoningEffort) } : {}) }
      const http = { ...shared, credentialRef: text(value.credentialRef), model: text(value.model) }
      if (kind === 'openai-decisions') return { ...http, cacheMode: value.cacheMode === 'implicit' ? 'implicit' : 'explicit' }
      return { ...http, baseURL: text(value.baseURL), ...(kind === 'openai-compatible' && text(value.api) ? { api: text(value.api) } : {}) }
    }

    /** Build the complete user-owned preset table, preserving unmanaged fields. */
    function buildPresetOverrides(draft, catalog) {
      const output = {}
      for (const preset of draft.presets) {
        output[preset.id] = {
          ...(preset.extra || {}),
          id: preset.id,
          label: text(preset.label),
          ...(text(preset.description) ? { description: text(preset.description) } : {}),
          fanout: normalizeFanout(preset.fanout),
          delivery: preset.delivery === 'background' ? 'background' : 'wait',
          ...(preset.referenceTimeoutMs === '' ? {} : { referenceTimeoutMs: preset.referenceTimeoutMs }),
          aggregator: buildAggregator(preset.aggregator),
          references: preset.references.map((reference, index) => buildReference(reference, index, catalog)),
        }
      }
      return output
    }

    function buildConfigPatch(draft, catalog) {
      const failure = validateDraft(draft, catalog)
      if (failure) {
        const error = new Error(failure.code)
        error.moa = failure
        throw error
      }
      const patch = {
        enabled: draft.enabled === true,
        defaultPreset: draft.presets.length ? draft.defaultPreset : '',
        disabledPresets: draft.presets.filter((preset) => preset.enabled === false).map((preset) => preset.id),
        presetOverrides: buildPresetOverrides(draft, catalog),
        decision: buildDecision(draft.decision),
        reviewTimeoutMs: draft.reviewTimeoutMs === '' ? REVIEW_TIMEOUT_DEFAULT : draft.reviewTimeoutMs,
      }
      // Hidden but Host-owned: preserve the live values instead of resetting
      // them just because this UI no longer renders a control.
      if (Array.isArray(draft.persistentTags)) patch.persistentTags = draft.persistentTags.map((tag) => String(tag))
      if (draft.referenceTimeoutMs !== '') patch.referenceTimeoutMs = draft.referenceTimeoutMs
      if (draft.deadlineMs !== '') patch.deadlineMs = draft.deadlineMs
      patch.guardEnabled = draft.guardEnabled === true
      return patch
    }

    /**
     * Race one remote read against the catalog budget while preserving both the
     * value and the failure: a page frozen in the background never settles the
     * underlying transport, and the panel must still leave `loading` and offer
     * a retry. The transport itself is not aborted; a late answer is ignored.
     */
    function withCatalogTimeout(promise, timeoutMs) {
      return new Promise((resolve) => {
        let decided = false
        const finish = (value) => {
          if (decided) return
          decided = true
          clearTimeout(timer)
          resolve(value)
        }
        const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs)
        Promise.resolve(promise).then(
          (value) => finish({ timedOut: false, value }),
          (error) => finish({ timedOut: false, error }),
        )
      })
    }

    function errorMessage(error) {
      if (typeof error === 'string') return error
      if (error && typeof error.message === 'string') return error.message
      if (error && typeof error.error === 'string') return error.error
      try { return JSON.stringify(error) } catch { return String(error) }
    }

    function remoteFailure(error, fallbackCode = 'settings/rejected') {
      const source = isRecord(error?.error) ? error.error : error
      const code = text(source?.code, fallbackCode)
      return { type: 'remote', code, message: errorMessage(source) }
    }

    function isConflict(error) {
      const code = text(error?.code || error?.error?.code).toLowerCase()
      return code.includes('conflict')
    }

    function emptyPresetDraft(used) {
      const label = `Preset ${used.length + 1}`
      return {
        id: nextPresetId(used, label),
        label,
        description: '',
        fanout: 'user_turn', delivery: 'wait', referenceTimeoutMs: '',
        aggregator: { provider: '', model: '', effortMode: 'follow', reasoningEffort: '', extra: {} },
        scheduler: null,
        references: [emptyReferenceDraft([])],
        enabled: true,
        extra: {},
      }
    }

    function emptyDecisionDraft() {
      return { ...DECISION_DEFAULTS, provider: '', reasoningEffort: '', extra: {} }
    }

    function emptyReferenceDraft(used) {
      const label = `Ref ${used.length + 1}`
      return {
        id: nextReferenceId(used, label),
        label,
        provider: '',
        model: '',
        reasoningEffort: '',
        maxTokens: '', contextWindow: '',
        enabled: true,
        persistent: '',
        continueOnStop: '',
        cacheScope: '',
        systemSuffix: '',
        sessionPolicy: '',
        extra: {},
      }
    }

    class MoaSettingsStore {
      constructor(ctx) {
        this.ctx = ctx
        this.scope = ctx.configForms.get(SETTINGS_NS)
        this.listeners = new Set()
        this.disposed = false
        this.catalogGeneration = 0
        this.editVersion = 0
        this.savedVersion = 0
        this.writeQueue = Promise.resolve()
        this.state = {
          status: 'loading', writable: false, revision: undefined, selectedPresetId: '',
          draft: undefined, base: undefined, dirty: false, saving: false, saved: false, error: undefined,
          catalog: { status: 'idle', groups: [], failures: [], refreshing: false, error: undefined },
        }
        this.unsubscribe = this.scope.subscribe(() => this.syncScope())
        this.syncScope()
      }
      getSnapshot = () => this.state
      subscribe = (listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
      set(patch) {
        if (this.disposed) return
        this.state = { ...this.state, ...patch }
        for (const listener of this.listeners) listener()
      }
      syncScope() {
        const scope = this.scope.getSnapshot()
        if (scope.status !== 'ready' || !isRecord(scope.value)) {
          this.set({ status: scope.status || 'loading', writable: scope.writable === true, revision: scope.revision })
          return
        }
        const incoming = draftFromValue(scope.value)
        const previous = this.state.draft
        const keep = previous && this.state.dirty && this.editVersion !== this.savedVersion
        const draft = keep ? previous : incoming
        let selectedPresetId = this.state.selectedPresetId
        if (!incoming.presets.some(preset => preset.id === selectedPresetId)) {
          let remembered = ''
          try { remembered = globalThis.sessionStorage?.getItem('better-moa.editPreset') || '' } catch { /* storage may be disabled */ }
          selectedPresetId = incoming.presets.some(preset => preset.id === remembered) ? remembered : incoming.defaultPreset || incoming.presets[0]?.id || ''
        }
        this.set({ status: 'ready', writable: scope.writable === true, revision: scope.revision,
          base: incoming, draft, selectedPresetId, dirty: draftSignature(draft) !== draftSignature(incoming) })
      }
      edit(mutator) {
        if (!this.state.draft || !this.state.writable) return false
        const draft = clone(this.state.draft)
        mutator(draft)
        this.editVersion += 1
        const failure = validateDraft(draft, this.state.catalog)
        const dirty = draftSignature(draft) !== draftSignature(this.state.base)
        if (!dirty) this.savedVersion = this.editVersion
        this.set({ draft, dirty, saved: !dirty && !failure, error: failure, saving: false })
        if (!failure && dirty) this.scheduleSave()
        else clearTimeout(this.saveTimer)
        return !failure
      }
      scheduleSave() {
        clearTimeout(this.saveTimer)
        this.saveTimer = setTimeout(() => { this.saveTimer = undefined; this.enqueueSave() }, AUTOSAVE_DEBOUNCE_MS)
      }
      enqueueSave() {
        if (!this.state.draft || !this.state.writable || !this.state.dirty) return this.writeQueue
        let patch
        try { patch = buildConfigPatch(this.state.draft, this.state.catalog) } catch { return this.writeQueue }
        const version = this.editVersion
        this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
          if (this.disposed) return
          this.set({ saving: true, saved: false })
          const revision = this.scope.getSnapshot().revision
          try {
            const operations = Object.entries(patch).map(([field, value]) => ({ op: 'set', path: [field], value }))
            await this.scope.mutate(operations, revision)
            this.savedVersion = Math.max(this.savedVersion, version)
            this.syncScope()
            this.set({ saving: false, saved: this.editVersion === version && !this.state.dirty, error: undefined })
          } catch (error) {
            this.set({ saving: false, saved: false, error: remoteFailure(error) })
            try { await this.ctx.configForms.describe().load() } catch { /* Host mirror already reports its own failure. */ }
          }
        })
        return this.writeQueue
      }
      async flushAutosave() {
        clearTimeout(this.saveTimer)
        this.saveTimer = undefined
        await this.enqueueSave()
        await this.writeQueue
        return !this.state.error
      }
      selectPreset(id) {
        if (!this.state.draft?.presets.some(preset => preset.id === id)) return
        try { globalThis.sessionStorage?.setItem('better-moa.editPreset', id) } catch { /* non-persistent fallback */ }
        this.set({ selectedPresetId: id })
      }
      addPreset() {
        let created
        this.edit(draft => {
          const preset = emptyPresetDraft(draft.presets)
          draft.presets.push(preset)
          if (!draft.defaultPreset) draft.defaultPreset = preset.id
          created = preset.id
        })
        if (created) this.selectPreset(created)
        return created
      }
      removePreset(id) {
        this.edit(draft => {
          draft.presets = draft.presets.filter(preset => preset.id !== id)
          if (draft.defaultPreset === id) draft.defaultPreset = draft.presets.find(preset => preset.enabled !== false)?.id || ''
        })
        if (this.state.selectedPresetId === id) this.selectPreset(this.state.draft.defaultPreset || this.state.draft.presets[0]?.id || '')
      }
      setPresetEnabled(id, enabled) {
        this.edit(draft => {
          const preset = draft.presets.find(entry => entry.id === id)
          if (!preset || (!enabled && draft.presets.filter(entry => entry.enabled !== false).length <= 1)) return
          preset.enabled = enabled !== false
          if (!preset.enabled && draft.defaultPreset === id) draft.defaultPreset = draft.presets.find(entry => entry.enabled !== false)?.id || ''
        })
      }
      setDefaultPreset(id) {
        this.edit(draft => {
          const preset = draft.presets.find(entry => entry.id === id)
          if (preset && preset.enabled !== false) draft.defaultPreset = id
        })
      }
      addReference(presetId) {
        let created
        this.edit(draft => {
          const preset = draft.presets.find(entry => entry.id === presetId)
          if (!preset) return
          const reference = emptyReferenceDraft(preset.references)
          preset.references.push(reference)
          created = reference.id
        })
        return created
      }
      removeReference(presetId, referenceId) {
        this.edit(draft => {
          const preset = draft.presets.find(entry => entry.id === presetId)
          if (preset) preset.references = preset.references.filter(reference => reference.id !== referenceId)
        })
      }
      async reload() {
        try { await this.ctx.configForms.describe().load(); this.syncScope(); return true }
        catch (error) { this.set({ error: { type: 'load', code: text(error?.code, 'settings/load'), message: errorMessage(error) } }); return false }
      }
      async loadCatalog() {
        const generation = ++this.catalogGeneration
        const previous = this.state.catalog
        const keepGroups = previous.groups.length > 0
        this.set({ catalog: { ...previous, status: keepGroups ? 'ready' : 'loading', refreshing: true, error: undefined } })
        const result = await withCatalogTimeout(this.ctx.remote.session.modelCatalog(), catalogTimeoutMs)
        if (this.disposed || generation !== this.catalogGeneration) return false
        if (result.timedOut || result.error || !result.value || result.value.ok !== true || !isRecord(result.value.value)) {
          const failure = result.error || result.value?.error || new Error(result.timedOut ? 'model catalog request timed out' : 'Invalid modelCatalog response')
          this.set({ catalog: { ...this.state.catalog, status: keepGroups ? 'ready' : 'error', refreshing: false,
            error: remoteFailure(failure, result.timedOut ? 'session/model-catalog-timeout' : 'session/model-catalog') } })
          return false
        }
        this.set({ catalog: { status: 'ready', groups: normalizeCatalogGroups(result.value.value.groups),
          failures: Array.isArray(result.value.value.failures) ? clone(result.value.value.failures) : [], refreshing: false, error: undefined } })
        return true
      }
      dispose() {
        this.disposed = true
        clearTimeout(this.saveTimer)
        this.catalogGeneration += 1
        this.unsubscribe?.()
        this.listeners.clear()
      }
    }
    function Field(label, input, hint, error) {
      return h('label', { className: 'dsh-moa-field' }, h('span', null, label), input,
        hint ? h('small', { className: 'dsh-moa-note' }, hint) : null,
        error ? h('small', { className: 'dsh-moa-error', role: 'alert' }, error) : null)
    }

    function Checkbox({ label, checked, onChange, disabled, title, dataName }) {
      return h('label', { className: 'dsh-moa-check', title },
        h('input', {
          type: 'checkbox', checked, disabled,
          ...(dataName ? { [dataName]: true } : {}),
          onChange: (event) => onChange(event.target.checked),
        }),
        h('span', null, label))
    }

    function NumberField({ label, value, min, max, step, onChange, placeholder, hint, dataName, invalid, error }) {
      return Field(label, h('input', {
        className: 'dsh-moa-input', type: 'number', min, ...(max === undefined ? {} : { max }), step: step || 1, value,
        placeholder: placeholder || undefined, ...(dataName ? { [dataName]: true } : {}),
        'aria-invalid': invalid || undefined,
        onChange: (event) => onChange(event.target.value === '' ? '' : Number(event.target.value)),
      }), hint || `${min}–${max}`, error)
    }

    /** Tri-state boolean: '' means auto/absent, true/false are explicit Host overrides. */
    function TriStateField({ label, value, onChange, t, autoLabel, dataName, hint }) {
      return Field(label, h('select', {
        className: 'dsh-moa-select',
        value: value === true ? 'on' : value === false ? 'off' : '',
        ...(dataName ? { [dataName]: true } : {}),
        onChange: (event) => {
          const next = event.target.value
          onChange(next === 'on' ? true : next === 'off' ? false : '')
        },
      },
      h('option', { value: '' }, autoLabel || t('auto')),
      h('option', { value: 'on' }, t('on')),
      h('option', { value: 'off' }, t('off'))), hint)
    }

    /**
     * Fixed-choice select. `options` is a list of { value, label } and `value`
     * is the stored literal ('' is the automatic/default choice).
     */
    function SelectField({ label, value, options, onChange, hint, dataName }) {
      return Field(label, h('select', {
        className: 'dsh-moa-select', value,
        ...(dataName ? { [dataName]: true } : {}),
        onChange: (event) => onChange(event.target.value),
      }, ...options.map(option => h('option', { value: option.value, key: option.value }, option.label))), hint)
    }

    /**
     * Provider/model picker. With a ready catalog both are native selects, so the
     * complete list is visible (a datalist with a filled value only matches
     * prefixes). A saved route missing from the catalog stays as an explicit
     * option and is never rewritten; without a catalog the fields fall back to
     * manual input.
     */
    function RouteEditor({ route, catalog, onChange, t, testId }) {
      const groups = selectableGroups(catalog)
      // Any usable catalog keeps the native selects: a background refresh must
      // never hide the complete list and downgrade the picker to manual input.
      const ready = groups.length > 0
      if (!ready) {
        return h('div', { className: 'dsh-moa-grid', 'data-moa-route': testId },
          Field(t('provider'), h('input', {
            className: 'dsh-moa-input', value: route.provider, autoComplete: 'off',
            'data-moa-route-provider': testId,
            onChange: (event) => onChange({ provider: event.target.value, model: route.model }),
          }), catalog?.status === 'loading' ? t('catalogLoading') : t('catalogManual')),
          Field(t('model'), h('input', {
            className: 'dsh-moa-input', value: route.model, autoComplete: 'off',
            'data-moa-route-model': testId,
            onChange: (event) => onChange({ provider: route.provider, model: event.target.value }),
          }), null),
          catalog?.status === 'error' ? h('p', { className: 'dsh-moa-warning', style: { gridColumn: '1 / -1' } }, t('catalogFailed')) : null)
      }
      const group = groups.find((entry) => entry.id === route.provider)
      const providerKnown = Boolean(group)
      const modelKnown = Boolean(group?.models.some((entry) => entry.id === route.model))
      const providerStale = Boolean(route.provider) && !providerKnown
      const modelStale = Boolean(route.provider && route.model) && providerKnown && !modelKnown
      return h('div', { className: 'dsh-moa-grid', 'data-moa-route': testId },
        Field(t('provider'), h('select', {
          className: 'dsh-moa-select', value: route.provider, 'data-moa-route-provider': testId,
          onChange: (event) => {
            const provider = event.target.value
            const target = groups.find((entry) => entry.id === provider)
            // Switching provider clears a model that provider does not offer, so
            // an incompatible saved pair can never survive the change.
            const keep = Boolean(target?.models.some((entry) => entry.id === route.model))
            onChange({ provider, model: keep ? route.model : '' })
          },
        },
        h('option', { value: '' }, t('selectProvider')),
        providerStale ? h('option', { value: route.provider }, `${route.provider} (${t('notInCatalog')})`) : null,
        groups.map((entry) => h('option', { key: entry.id, value: entry.id },
          entry.name && entry.name !== entry.id ? `${entry.name} (${entry.id})` : entry.id)))),
        Field(t('model'), h('select', {
          className: 'dsh-moa-select', value: route.model, 'data-moa-route-model': testId,
          disabled: !route.provider,
          onChange: (event) => onChange({ provider: route.provider, model: event.target.value }),
        },
        h('option', { value: '' }, route.provider ? t('selectModel') : t('selectProviderFirst')),
        route.model && !modelKnown ? h('option', { value: route.model }, `${route.model} (${t('notInCatalog')})`) : null,
        (group?.models || []).map((entry) => h('option', { key: entry.id, value: entry.id },
          entry.name && entry.name !== entry.id ? `${entry.name} (${entry.id})` : entry.id))), null),
        modelStale ? h('p', { className: 'dsh-moa-warning', style: { gridColumn: '1 / -1' } }, t('routeStale')) : null,
        providerStale ? h('p', { className: 'dsh-moa-warning', style: { gridColumn: '1 / -1' } }, t('routeStale')) : null)
    }

    function EffortField({ reference, model, onChange, t }) {
      const support = effortSupport(model)
      if (support === 'unsupported') {
        return h('div', { className: 'dsh-moa-field', 'data-moa-effort-unsupported': true },
          h('span', null, t('effort')),
          h('p', { className: 'dsh-moa-note' },
            reference.reasoningEffort ? `${t('effortUnsupported')} (${reference.reasoningEffort})` : t('effortUnsupported')))
      }
      if (support === 'unknown') {
        return Field(t('effort'), h('input', {
          className: 'dsh-moa-input', value: reference.reasoningEffort, autoComplete: 'off',
          placeholder: t('effortDefault'), 'data-moa-ref-effort': true,
          onChange: (event) => onChange(event.target.value),
        }), t('effortUnknown'))
      }
      const reasoning = isRecord(model.reasoning) ? model.reasoning : {}
      const efforts = Array.isArray(reasoning.efforts)
        ? reasoning.efforts.map((effort) => (typeof effort === 'string' ? { id: effort, name: effort } : effort)) : []
      const known = efforts.some((effort) => effort.id === reference.reasoningEffort)
      return Field(t('effort'), h('select', {
        className: 'dsh-moa-select', value: reference.reasoningEffort, 'data-moa-ref-effort': true,
        onChange: (event) => onChange(event.target.value),
      },
      h('option', { value: '' }, reasoning.defaultEffort ? `${t('effortDefault')} · ${reasoning.defaultEffort}` : t('effortDefault')),
      efforts.map((effort) => h('option', { key: effort.id, value: effort.id }, effort.name || effort.id)),
      reference.reasoningEffort && !known
        ? h('option', { value: reference.reasoningEffort }, `${reference.reasoningEffort} (${t('notInCatalog')})`) : null),
      reasoning.defaultEffort ? `${t('defaultEffort')}: ${reasoning.defaultEffort}` : t('effortDefault'))
    }

    /**
     * Aggregator effort. The first option is always 'follow' — the Host's
     * default when `effortMode` is absent — so a legacy preset that stores
     * reasoningEffort without a mode shows follow and those bytes are preserved.
     * A model that publishes no efforts can only follow, so the select is
     * disabled (with its reason) rather than offering a value the Host would
     * reject; an unknown route cannot be judged, so follow is offered with a
     * warning instead of blocking the save.
     */
    function AggregatorEffortField({ aggregator, catalog, model, onChange, t }) {
      const support = effortSupport(model)
      const reasoning = isRecord(model?.reasoning) ? model.reasoning : {}
      const catalogsEfforts = Array.isArray(reasoning.efforts)
        ? reasoning.efforts.map((effort) => (typeof effort === 'string' ? { id: effort, name: effort } : effort)) : []
      const fixed = normalizeEffortMode(aggregator.effortMode) === 'fixed'
      // The value the select shows: 'follow' unless the preset pins a level.
      const value = fixed ? text(aggregator.reasoningEffort) : ''
      const known = catalogsEfforts.some((effort) => effort.id === value)
      const disabled = support === 'unsupported'
      const hint = support === 'unsupported'
        ? t('aggregatorEffortUnsupported')
        : support === 'unknown' ? t('aggregatorEffortUnknown') : t('aggregatorEffortHint')
      return Field(t('aggregatorEffort'), h('select', {
        className: 'dsh-moa-select', value, ...(disabled ? { disabled: true } : {}),
        'data-moa-aggregator-effort': true,
        'aria-label': t('aggregatorEffort'),
        onChange: (event) => onChange(event.target.value),
      },
      h('option', { value: '' }, t('followPicker')),
      catalogsEfforts.map((effort) => h('option', { key: effort.id, value: effort.id }, effort.name || effort.id)),
      // A pinned level the refreshed catalog no longer lists stays selectable
      // instead of silently snapping back to follow.
      fixed && value && !known ? h('option', { value }, `${value} (${t('notInCatalog')})`) : null), hint)
    }

    async function testDecisionConnection({ decision, catalog, apiKey, remote }) {
      const kind = decisionKind(decision.kind)
      if (kind === 'dsh-model') {
        const found = findModel(catalog, decision.provider, decision.model)
        return { ok: Boolean(found), code: found ? 'testCatalogSuccess' : 'testCatalogFailure' }
      }
      if (kind === 'none') return { ok: true, code: 'testCatalogSuccess' }
      if (!apiKey) return { ok: false, code: 'testNeedsKey' }
      const request = { baseURL: decision.baseURL, apiKey }
      if (kind === 'openai-compatible' && text(decision.api)) request.api = text(decision.api)
      const result = await remote.llm.discoverModels(SETTINGS_NS, request)
      const ok = result?.ok !== false
      return { ok, code: ok ? 'testSuccess' : 'testFailed' }
    }

    function DecisionSection({ decision, catalog, store, onChange, confirmNone, validation, t }) {
      const kind = decisionKind(decision.kind)
      const [apiKey, setApiKey] = React.useState('')
      const [configured, setConfigured] = React.useState(false)
      const [testing, setTesting] = React.useState(false)
      const [testResult, setTestResult] = React.useState(undefined)
      const credentialRef = decision.credentialRef || (kind === 'jev' ? 'TYPESAFE_API_KEY' : kind === 'openai-compatible' ? 'BETTER_MOA_DECISION_API_KEY' : 'MOA_OPENAI_API_KEY')
      React.useEffect(() => {
        let live = true
        setApiKey(''); setTestResult(undefined); setConfigured(false)
        if (kind !== 'none' && kind !== 'dsh-model' && store.ctx.remote.credentials?.describe) {
          Promise.resolve(store.ctx.remote.credentials.describe(credentialRef)).then(result => {
            if (!live) return
            const value = result?.ok === true ? result.value : result
            setConfigured(value?.configured === true || value?.status === 'configured')
          }).catch(() => { if (live) setConfigured(false) })
        }
        return () => { live = false }
      }, [kind, credentialRef])
      const number = name => h(NumberField, {
        label: t(`scheduler${name[0].toUpperCase()}${name.slice(1)}`), value: decision[name],
        min: SCHEDULER_LIMITS[name].min, max: SCHEDULER_LIMITS[name].max, step: SCHEDULER_LIMITS[name].step,
        hint: t(name === 'threshold' ? 'schedulerThresholdHint' : name === 'timeoutMs' ? 'schedulerTimeoutHint' : name === 'stateChars' ? 'schedulerStateCharsHint' : 'schedulerGapHint'),
        dataName: `data-moa-scheduler-${name}`, invalid: validation?.field === `decision.${name}`,
        error: validation?.field === `decision.${name}` ? localizedError(validation, t) : undefined,
        onChange: value => onChange(draft => { draft[name] = value }),
      })
      const safeError = error => {
        const message = errorMessage(error)
        return apiKey ? message.split(apiKey).join('[redacted]') : message
      }
      const saveCredential = async () => {
        if (!apiKey || !store.ctx.remote.credentials?.set) return
        try {
          await store.ctx.remote.credentials.set(credentialRef, apiKey)
          setApiKey(''); setConfigured(true); setTestResult({ ok: true, message: t('credentialSaved') })
        } catch (error) { setTestResult({ ok: false, message: `${t('credentialSaveFailed')}: ${safeError(error)}` }) }
      }
      const testConnection = async () => {
        setTesting(true); setTestResult(undefined)
        try {
          const result = await testDecisionConnection({ decision, catalog, apiKey, remote: store.ctx.remote })
          setTestResult({ ok: result.ok, message: t(result.code) })
        } catch (error) { setTestResult({ ok: false, message: `${t('testFailed')}: ${safeError(error)}` }) }
        finally { setTesting(false) }
      }
      const credentialFields = () => h('div', { className: 'dsh-moa-credential' },
        Field(t('credentialValue'), h('div', { className: 'dsh-moa-row' },
          h('input', {
            className: 'dsh-moa-input', type: 'password', value: apiKey, autoComplete: 'new-password',
            placeholder: t('credentialPlaceholder'), 'data-moa-decision-api-key': true,
            'aria-invalid': validation?.field === 'decision.credentialRef' || undefined,
            onChange: event => setApiKey(event.target.value),
          }),
          configured ? h('span', { className: 'dsh-moa-badge', 'data-moa-credential-configured': true }, t('credentialConfigured')) : null),
        configured ? undefined : t('credentialNotConfigured')),
        validation?.field === 'decision.credentialRef' ? h('small', { className: 'dsh-moa-error', role: 'alert' }, localizedError(validation, t)) : null,
        h('div', { className: 'dsh-moa-row' },
          h('button', { type: 'button', className: 'dsh-moa-button', disabled: !apiKey, onClick: saveCredential,
            'data-moa-save-credential': true }, t('saveCredential'))))
      return h('div', { className: 'dsh-moa-scheduler', 'data-moa-scheduler': true },
        h('h4', { className: 'dsh-moa-reference-title' }, t('schedulerTitle')),
        h('small', { className: 'dsh-moa-note' }, t('schedulerHint')),
        Field(t('schedulerKind'), h('select', {
          className: 'dsh-moa-select', value: kind, 'data-moa-scheduler-kind': true,
          onChange: event => {
            const next = event.target.value
            if (next === 'none' && !confirmNone()) return
            setTestResult(undefined)
            onChange(draft => {
              draft.kind = next
              if (next === 'jev') { draft.model ||= 'jev-latest'; draft.baseURL ||= 'https://api.typesafe.ai/v1/systemone'; draft.credentialRef = 'TYPESAFE_API_KEY' }
              if (next === 'openai-decisions') { draft.model = 'gpt-6-luna'; draft.credentialRef = 'MOA_OPENAI_API_KEY'; draft.baseURL = 'https://api.openai.com/v1' }
              if (next === 'openai-compatible') { if (kind !== 'openai-compatible') draft.model = ''; draft.baseURL = ''; draft.credentialRef = 'BETTER_MOA_DECISION_API_KEY' }
            })
          },
        }, DECISION_KINDS.map(value => h('option', { key: value, value }, t(`decisionKind_${value}`))))),
        kind === 'dsh-model' ? h('div', { 'data-moa-scheduler-model': true },
          h(RouteEditor, { route: decision, catalog, t, testId: 'scheduler', onChange: next => onChange(draft => {
            draft.provider = next.provider; draft.model = next.model
            if (effortSupport(findModel(catalog, next.provider, next.model)) === 'unsupported') draft.reasoningEffort = ''
          }) }),
          h(EffortField, { reference: decision, model: findModel(catalog, decision.provider, decision.model), t,
            onChange: value => onChange(draft => { draft.reasoningEffort = value }) })) : null,
        kind !== 'none' && kind !== 'dsh-model' ? h('div', { 'data-moa-scheduler-openai': true },
          Field(t('schedulerJevModel'), h('input', { className: 'dsh-moa-input', value: decision.model, autoComplete: 'off',
            'data-moa-decision-model': true, 'aria-invalid': validation?.field === 'decision.model' || undefined,
            onChange: event => onChange(draft => { draft.model = event.target.value }) })),
          kind !== 'openai-decisions' ? Field(t('decisionBaseURL'), h('input', { className: 'dsh-moa-input', value: decision.baseURL,
            autoComplete: 'off', 'data-moa-decision-base-url': true,
            'aria-invalid': validation?.field === 'decision.baseURL' || undefined,
            onChange: event => onChange(draft => { draft.baseURL = event.target.value }) }),
          validation?.field === 'decision.baseURL' ? localizedError(validation, t) : undefined) : null,
          kind === 'openai-compatible' ? Field(t('decisionApi'), h('select', { className: 'dsh-moa-select', value: decision.api,
            'data-moa-decision-api': true, onChange: event => onChange(draft => { draft.api = event.target.value }) },
          h('option', { value: '' }, t('contextWindowAuto')),
          OPENAI_COMPATIBLE_APIS.map(api => h('option', { key: api, value: api }, api))), t('decisionApiHint')) : null,
          credentialFields(),
          kind === 'openai-decisions' ? Field(t('schedulerCacheMode'), h('select', { className: 'dsh-moa-select',
            value: decision.cacheMode || 'explicit', 'data-moa-scheduler-cache-mode': true,
            onChange: event => onChange(draft => { draft.cacheMode = event.target.value }) },
          h('option', { value: 'explicit' }, t('schedulerCacheExplicit')),
          h('option', { value: 'implicit' }, t('schedulerCacheImplicit'))), t('schedulerCacheHint')) : null) : null,
        kind !== 'none' ? h('div', { className: 'dsh-moa-row' },
          h('button', { type: 'button', className: 'dsh-moa-button', disabled: testing, onClick: testConnection,
            'data-moa-test-decision': true }, testing ? t('testing') : t('testConnection'))) : null,
        testResult ? h('p', { className: testResult.ok ? 'dsh-moa-status' : 'dsh-moa-error', role: 'status' }, testResult.message) : null,
        h('div', { className: 'dsh-moa-grid' }, number('threshold'), number('minGap'), number('maxGap'), number('timeoutMs'), number('stateChars')))
    }
    function PresetEditor({ preset, catalog, enabledCount, isDefault, store, t, validation, globalReferenceTimeoutMs }) {
      const [confirming, setConfirming] = React.useState(false)
      const update = (mutator) => store.edit((draft) => {
        const target = draft.presets.find((entry) => entry.id === preset.id)
        if (target) mutator(target)
      })
      const updateReference = (referenceId, mutator) => update((target) => {
        const reference = target.references.find((entry) => entry.id === referenceId)
        if (reference) mutator(reference)
      })
      const mode = fanoutMode(preset.fanout)
      const count = fanoutCount(preset.fanout)
      const enabledReferences = preset.references.filter((reference) => reference.enabled !== false)
      // Cadence remains per preset; the judge is shared in General settings.
      const changeFanout = (next) => update((draft) => {
        draft.fanout = next === 'every_n' ? `every_n:${count || 10}` : next
      })
      // Effort: follow keeps the carried value untouched (it rides along and is
      // inert on the Host); picking a level pins it, picking follow unpins it.
      const changeAggregatorEffort = (value) => update((draft) => {
        if (value === '') {
          draft.aggregator.effortMode = 'follow'
        } else {
          draft.aggregator.effortMode = 'fixed'
          draft.aggregator.reasoningEffort = value
        }
      })
      return h('section', { className: 'dsh-moa-card', 'data-moa-preset': preset.id },
        h('div', { className: 'dsh-moa-row' },
          h('input', {
            className: 'dsh-moa-input dsh-moa-preset-name', value: preset.label, placeholder: t('presetName'),
            'aria-label': t('presetName'), 'data-moa-preset-name': preset.id,
            onChange: (event) => update((draft) => { draft.label = event.target.value }),
          }),
          h(Checkbox, {
            label: t('presetEnabled'), checked: preset.enabled !== false,
            disabled: preset.enabled !== false && enabledCount <= 1,
            title: preset.enabled !== false && enabledCount <= 1 ? t('lastPreset') : undefined,
            onChange: (checked) => store.setPresetEnabled(preset.id, checked),
          }),
          h('button', {
            type: 'button', className: `dsh-moa-button${isDefault ? ' dsh-moa-primary' : ''}`,
            'aria-pressed': isDefault, disabled: preset.enabled === false,
            onClick: () => store.setDefaultPreset(preset.id),
          }, isDefault ? t('defaultBadge') : t('setDefault')),
          h('div', { className: 'dsh-moa-spacer' })),
        Field(t('presetDescription'), h('input', {
          className: 'dsh-moa-input', value: preset.description, autoComplete: 'off',
          onChange: (event) => update((draft) => { draft.description = event.target.value }),
        }), t('presetDescriptionHint')),
        h('div', { className: 'dsh-moa-grid' },
          Field(t('fanout'), h('select', {
            className: 'dsh-moa-select', value: mode,
            'data-moa-fanout': preset.id,
            onChange: (event) => changeFanout(event.target.value),
          }, ['user_turn', 'smart', 'user_turn_end', 'every_n'].map((value) => h('option', { key: value, value }, t(value)))),
          t('fanoutHint')),
          count !== undefined ? h(NumberField, {
            label: t('fanoutN'), value: count, min: 1, max: FANOUT_MAX,
            onChange: (value) => update((draft) => { if (value !== '') draft.fanout = `every_n:${value}` }),
          }) : null,
          Field(t('delivery'), h('select', {
            className: 'dsh-moa-select', value: preset.delivery, 'data-moa-delivery': preset.id,
            onChange: event => update(draft => { draft.delivery = event.target.value }),
          },
          h('option', { value: 'wait' }, t('deliveryWait')),
          h('option', { value: 'background' }, t('deliveryBackground')))),
          h(NumberField, {
            label: t('presetReferenceTimeout'), value: preset.referenceTimeoutMs === '' ? '' : preset.referenceTimeoutMs / 1000,
            min: 1, max: 1800, step: 1, placeholder: String((globalReferenceTimeoutMs || 600000) / 1000),
            hint: t('presetReferenceTimeoutHint'), dataName: 'data-moa-preset-reference-timeout',
            invalid: validation?.field === `${preset.id}.referenceTimeoutMs`,
            error: validation?.field === `${preset.id}.referenceTimeoutMs` ? localizedError(validation, t) : undefined,
            onChange: value => update(draft => { draft.referenceTimeoutMs = value === '' ? '' : value * 1000 }),
          })), 
        h('h4', { className: 'dsh-moa-reference-title' }, t('aggregator')),
        h(RouteEditor, {
          route: preset.aggregator, catalog, t, testId: 'aggregator',
          onChange: (next) => update((draft) => {
            // A pinned effort the new model does not advertise falls back to
            // follow rather than silently saving an unsupported level.
            const support = effortSupport(findModel(catalog, next.provider, next.model))
            const efforts = modelEfforts(catalog, next.provider, next.model)
            if (draft.aggregator.effortMode === 'fixed' && support === 'supported'
              && !efforts.includes(draft.aggregator.reasoningEffort)) {
              draft.aggregator.effortMode = 'follow'
            }
            if (support === 'unsupported') draft.aggregator.effortMode = 'follow'
            draft.aggregator.provider = next.provider
            draft.aggregator.model = next.model
          }),
        }),
        h(AggregatorEffortField, {
          aggregator: preset.aggregator,
          catalog,
          model: findModel(catalog, preset.aggregator.provider, preset.aggregator.model),
          onChange: changeAggregatorEffort,
          t,
        }),
        preset.fanout === 'smart' ? h('p', { className: 'dsh-moa-note', 'data-moa-shared-scheduler-hint': true }, t('sharedSchedulerHint')) : null,
        h('div', { className: 'dsh-moa-row' },
          h('h4', { className: 'dsh-moa-reference-title' }, `${t('references')} (${enabledReferences.length}/${preset.references.length})`),
          h('div', { className: 'dsh-moa-spacer' }),
          h('button', {
            type: 'button', className: 'dsh-moa-button',
            onClick: () => store.addReference(preset.id),
          }, t('addReference'))),
        preset.references.length
          ? preset.references.map((reference, index) => {
            const model = findModel(catalog, reference.provider, reference.model)
            return h('div', { className: 'dsh-moa-reference', key: reference.id, 'data-moa-reference': reference.id },
              h('div', { className: 'dsh-moa-row' },
                h('input', {
                  className: 'dsh-moa-input dsh-moa-ref-name', value: reference.label,
                  placeholder: `Ref ${index + 1}`, 'aria-label': t('referenceName'), 'data-moa-ref-name': reference.id,
                  onChange: (event) => updateReference(reference.id, (draft) => { draft.label = event.target.value }),
                }),
                h('div', { className: 'dsh-moa-spacer' }),
                h(Checkbox, {
                  label: t('referenceEnabled'), checked: reference.enabled !== false,
                  onChange: (checked) => updateReference(reference.id, (draft) => { draft.enabled = checked }),
                }),
                h('button', {
                  type: 'button', className: 'dsh-moa-button',
                  'aria-label': `${t('removeReference')} ${reference.label || index + 1}`,
                  onClick: () => store.removeReference(preset.id, reference.id),
                }, t('removeReference'))),
              h(RouteEditor, {
                route: reference, catalog, t, testId: `reference:${reference.id}`,
                onChange: (next) => updateReference(reference.id, (draft) => {
                  const previousModel = draft.model
                  draft.provider = next.provider
                  draft.model = next.model
                  // A newly chosen model that publishes no efforts must not keep
                  // an effort value the Host would forward to the backend.
                  if (previousModel !== next.model
                    && effortSupport(findModel(catalog, draft.provider, draft.model)) === 'unsupported') {
                    draft.reasoningEffort = ''
                  }
                }),
              }),
              h('div', { className: 'dsh-moa-grid' },
                h(EffortField, {
                  reference, model, t,
                  onChange: (value) => updateReference(reference.id, (draft) => { draft.reasoningEffort = value }),
                }),
                h(NumberField, {
                  label: t('maxTokens'), value: reference.maxTokens, min: 1,
                  placeholder: t('effortDefault'), dataName: 'data-moa-ref-max-tokens',
                  hint: t('maxTokensHint'),
                  onChange: (value) => updateReference(reference.id, (draft) => { draft.maxTokens = value }),
                }),
                h(NumberField, {
                  label: t('contextWindow'), value: reference.contextWindow, min: 8192, max: 10000000,
                  placeholder: t('contextWindowAuto'), dataName: 'data-moa-ref-context-window', hint: t('contextWindowHint'),
                  invalid: validation?.field === `${preset.id}.references.${index}.contextWindow`,
                  error: validation?.field === `${preset.id}.references.${index}.contextWindow` ? localizedError(validation, t) : undefined,
                  onChange: value => updateReference(reference.id, draft => { draft.contextWindow = value }),
                })), 
              h('details', { className: 'dsh-moa-advanced' },
                h('summary', null, t('advancedOptions')),
                h('p', { className: 'dsh-moa-note' }, t('advancedHint')),
                h('div', { className: 'dsh-moa-grid' },
                  h(TriStateField, {
                    label: t('referencePersistent'), value: reference.persistent, t,
                    autoLabel: t('autoPersistent'), dataName: 'data-moa-ref-persistent',
                    onChange: (value) => updateReference(reference.id, (draft) => { draft.persistent = value }),
                  }),
                  h(TriStateField, {
                    label: t('referenceContinueOnStop'), value: reference.continueOnStop, t,
                    autoLabel: t('autoContinueOnStop'), dataName: 'data-moa-ref-continue-on-stop',
                    onChange: (value) => updateReference(reference.id, (draft) => { draft.continueOnStop = value }),
                  })),
                h('div', { className: 'dsh-moa-grid' },
                  Field(t('cacheScope'), h('input', {
                    className: 'dsh-moa-input', value: reference.cacheScope, autoComplete: 'off',
                    'data-moa-ref-cache-scope': true,
                    onChange: (event) => updateReference(reference.id, (draft) => { draft.cacheScope = event.target.value }),
                  }), t('cacheScopeHint')),
                  Field(t('systemSuffix'), h('input', {
                    className: 'dsh-moa-input', value: reference.systemSuffix, autoComplete: 'off',
                    'data-moa-ref-system-suffix': true,
                    onChange: (event) => updateReference(reference.id, (draft) => { draft.systemSuffix = event.target.value }),
                  }), t('systemSuffixHint')),
                  h(SelectField, {
                    label: t('sessionPolicy'), value: reference.sessionPolicy,
                    options: [
                      { value: '', label: t('sessionPolicy_auto') },
                      { value: 'stable', label: t('sessionPolicy_stable') },
                      { value: 'rotate', label: t('sessionPolicy_rotate') },
                    ],
                    dataName: 'data-moa-ref-session-policy', hint: t('sessionPolicyHint'),
                    onChange: (value) => updateReference(reference.id, (draft) => { draft.sessionPolicy = value }),
                  })),
                h('p', { className: 'dsh-moa-note' }, t('persistentHint')),
                h('p', { className: 'dsh-moa-note' }, t('continueOnStop')))
            )
          })
          : h('p', { className: 'dsh-moa-note' }, t('noReferences')),
        h('div', { className: 'dsh-moa-row', 'data-moa-preset-actions': preset.id },
          confirming
            ? h(React.Fragment, null,
              h('span', { className: 'dsh-moa-note' }, t('confirmDelete')),
              h('button', { type: 'button', className: 'dsh-moa-button', onClick: () => store.removePreset(preset.id) }, t('deletePreset')),
              h('button', { type: 'button', className: 'dsh-moa-button', onClick: () => setConfirming(false) }, t('cancelDelete')))
            : h('button', { type: 'button', className: 'dsh-moa-button', onClick: () => setConfirming(true) }, t('deletePreset')),
          h('button', { type: 'button', className: 'dsh-moa-button', 'data-moa-add-preset': true, onClick: () => store.addPreset() }, t('addPreset'))))
    }

    function localizedError(error, t) {
      if (!error) return ''
      if (error.type === 'validation') {
        const detail = error.field ? ` [${error.field}${error.min !== undefined ? `: ${error.min}–${error.max}` : ''}]` : ''
        return `${t(error.code)}${detail}`
      }
      if (error.type === 'confirm') return `${t('saveFailed')}: ${t('awaitingDetail')}`
      const prefix = error.type === 'load' ? t('loadFailed') : t('saveFailed')
      return `${prefix}: ${error.message || t('unknownError')}${error.code ? ` (${error.code})` : ''}`
    }

    function MoaSettingsSection(props) {
      const state = props.useMoaSettings((value) => value)
      const t = props.t
      React.useEffect(() => {
        props.loadCatalog()
        // Load once per mount: re-running on a changed prop identity would
        // restart the bounded read on every child re-render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])
      if (!state.draft) {
        return h('section', { className: 'dsh-moa-section' },
          h('h2', { className: 'dsh-moa-title' }, t('title')),
          h('p', { className: state.status === 'unavailable' ? 'dsh-moa-error' : 'dsh-moa-status' },
            state.status === 'unavailable' ? t('unavailable') : t('loading')),
          state.error ? h('p', { className: 'dsh-moa-error', role: 'alert' }, localizedError(state.error, t)) : null,
          h('button', { type: 'button', className: 'dsh-moa-button', onClick: props.reload }, t('retry')))
      }
      const draft = state.draft
      const disabled = !state.writable
      const enabledPresets = draft.presets.filter((preset) => preset.enabled !== false)
      const hasSmartPreset = enabledPresets.some(preset => preset.fanout === 'smart')
      const smartWithoutDecision = draft.decision.kind === 'none' && hasSmartPreset
      const confirmNone = () => !hasSmartPreset || globalThis.confirm?.(t('confirmNoDecision')) === true
      const selectedPreset = draft.presets.find(preset => preset.id === state.selectedPresetId)
        || draft.presets.find(preset => preset.id === draft.defaultPreset) || draft.presets[0]
      return h('section', { className: 'dsh-moa-section', 'aria-label': t('title') },
        h('h2', { className: 'dsh-moa-title' }, t('title')),
        h('p', { className: 'dsh-moa-intro' }, t('intro')),
        state.error ? h('p', { className: 'dsh-moa-error', role: 'alert' }, localizedError(state.error, t)) : null,
        smartWithoutDecision ? h('p', { className: 'dsh-moa-warning', role: 'alert', 'data-moa-no-decision-warning': true }, t('noDecisionWarning')) : null,
        !state.writable ? h('p', { className: 'dsh-moa-error', role: 'alert' }, t('notWritable')) : null,
        state.catalog.error
          ? h('p', { className: 'dsh-moa-warning', role: 'status' },
            state.catalog.error.code === 'session/model-catalog-timeout'
              ? t('catalogTimeout')
              : `${t('catalogFailed')} ${state.catalog.error.message || t('unknownError')}`)
          : null,
        state.catalog.failures.length ? h('p', { className: 'dsh-moa-warning' }, t('catalogFailures')) : null,
        h('fieldset', { className: 'dsh-moa-fields', disabled },
          h('section', { className: 'dsh-moa-card' },
            h('h3', { className: 'dsh-moa-card-title' }, t('commonTitle')),
            h(Checkbox, {
              label: t('enabled'), checked: draft.enabled,
              onChange: (value) => props.store.edit((next) => { next.enabled = value }),
            }),
            h('div', { className: 'dsh-moa-grid' },
              Field(t('defaultPreset'), h('select', {
                className: 'dsh-moa-select', value: draft.defaultPreset,
                'data-moa-default-preset': true, disabled: enabledPresets.length === 0,
                onChange: (event) => props.store.setDefaultPreset(event.target.value),
              },
              enabledPresets.length
                ? enabledPresets.map((preset) => h('option', { key: preset.id, value: preset.id }, preset.label || preset.id))
                : h('option', { value: '' }, t('noDefault'))), t('defaultPresetHint'))),
            h('div', { className: 'dsh-moa-field' },
              h(Checkbox, {
                label: t('guardEnabled'), checked: draft.guardEnabled,
                onChange: (value) => props.store.edit((next) => { next.guardEnabled = value }),
              }),
              h('small', { className: 'dsh-moa-note' }, t('guardHint'))),
            h(DecisionSection, {
              decision: draft.decision, catalog: state.catalog, store: props.store, t,
              validation: state.error?.type === 'validation' ? state.error : undefined, confirmNone,
              onChange: mutator => props.store.edit(next => mutator(next.decision)),
            }),
            h('details', { className: 'dsh-moa-advanced', 'data-moa-global-advanced': true },
              h('summary', null, t('commonAdvanced')),
              h(NumberField, {
                label: t('reviewTimeoutMs'), value: draft.reviewTimeoutMs,
                min: TIMEOUT_MIN, max: REVIEW_TIMEOUT_MAX, step: 1,
                placeholder: String(REVIEW_TIMEOUT_DEFAULT), hint: t('reviewTimeoutHint'),
                dataName: 'data-moa-review-timeout',
                invalid: state.error?.field === 'reviewTimeoutMs',
                error: state.error?.field === 'reviewTimeoutMs' ? localizedError(state.error, t) : undefined,
                onChange: (value) => props.store.edit((next) => { next.reviewTimeoutMs = value }),
              })),
            h('p', { className: 'dsh-moa-note' }, t('fixedNote'))),
          h('section', { className: 'dsh-moa-card' },
            h('div', { className: 'dsh-moa-row' },
              h('h3', { className: 'dsh-moa-card-title' }, `${t('presetsTitle')} (${draft.presets.length})`),
              h('div', { className: 'dsh-moa-spacer' })),
            selectedPreset ? Field(t('editPreset'), h('select', {
              className: 'dsh-moa-select', value: selectedPreset.id, 'data-moa-preset-selector': true,
              onChange: event => props.store.selectPreset(event.target.value),
            }, draft.presets.map(preset => h('option', { key: preset.id, value: preset.id }, preset.label || preset.id))), t('editPresetHint')) : null,
            draft.presets.length === 0
              ? h('div', { className: 'dsh-moa-empty' },
                h('p', { className: 'dsh-moa-note' }, t('presetsEmpty')),
                h('button', { type: 'button', className: 'dsh-moa-button', 'data-moa-add-preset': true, onClick: () => props.store.addPreset() }, t('addPreset')))
              : null,
            draft.presets.length > 0 && enabledPresets.length === 0
              ? h('p', { className: 'dsh-moa-warning', role: 'alert' }, t('noEnabledPresets'))
              : null,
            selectedPreset ? h(PresetEditor, {
              key: selectedPreset.id, preset: selectedPreset, catalog: state.catalog,
              enabledCount: enabledPresets.length,
              isDefault: draft.defaultPreset === selectedPreset.id,
              store: props.store, t, validation: state.error?.type === 'validation' ? state.error : undefined,
              globalReferenceTimeoutMs: draft.referenceTimeoutMs,
            }) : null,
            h('p', { className: 'dsh-moa-note' }, t('presetsIntro')))),
        state.catalog.status === 'loading' || state.catalog.refreshing
          ? h('p', { className: 'dsh-moa-note' }, t('catalogLoading')) : null,
        !state.catalog.groups.length && !state.catalog.refreshing && state.catalog.status !== 'loading' && !state.catalog.error
          ? h('p', { className: 'dsh-moa-note' }, t('catalogEmpty')) : null,
        h('div', { className: 'dsh-moa-footer dsh-moa-row' },
          h('span', { className: `dsh-moa-status${state.saved ? ' dsh-moa-saved' : state.dirty ? ' dsh-moa-dirty' : ''}`, role: 'status' },
            state.saving || state.dirty ? t('saving') : state.error ? t('saveFailed') : state.saved ? t('saved') : t('clean'))))
    }

    /**
     * One card for both injectable forms. `form` comes from the message's
     * source (see advice-renderer.js): 'advice' for in-turn reference material,
     * 'review' for the end-of-turn QA pass. Only the label and the notice text
     * differ — the body is the model's own text either way.
     */
    function AdviceCard(props) {
      const t = props.t
      const [expanded, setExpanded] = React.useState(false)
      const text = typeof props.text === 'string' ? props.text : ''
      const review = props.form === 'review'
      return h('article', {
        className: 'dsh-moa-advice', 'data-moa-advice': props.preset || 'advice',
        'data-moa-advice-form': review ? 'review' : 'advice', role: 'note',
      },
      h('div', { className: 'dsh-moa-advice-header' },
        h('strong', null, review ? t('reviewTitle') : t('adviceTitle')),
        h('span', { className: 'dsh-moa-note' }, review ? t('reviewNotice') : t('adviceNotice')),
        props.preset ? h('span', { className: 'dsh-moa-advice-preset' }, props.preset) : null,
        props.replacesEarlier ? h('span', { className: 'dsh-moa-note' }, t('adviceReplaced')) : null,
        h('span', { className: 'dsh-moa-spacer' }),
        h('button', {
          type: 'button', className: 'dsh-moa-button dsh-moa-advice-toggle',
          'aria-expanded': expanded, onClick: () => setExpanded(!expanded),
        }, expanded ? t('adviceCollapse') : review ? t('reviewExpand') : t('adviceExpand'))),
      expanded ? h('pre', { className: 'dsh-moa-advice-text' }, text) : null)
    }

    LOCALES.zh.adviceTitle = 'MoA 参考意见'
    LOCALES.zh.adviceNotice = '独立建议'
    LOCALES.zh.adviceReplaced = '已替换上一版'
    LOCALES.zh.adviceCollapse = '收起'
    LOCALES.zh.adviceExpand = '展开参考意见'
    LOCALES.zh.reviewTitle = 'MoA 结束前审阅'
    LOCALES.zh.reviewNotice = 'QA 意见'
    LOCALES.zh.reviewExpand = '展开审阅'
    LOCALES.en.adviceTitle = 'MoA reference advice'
    LOCALES.en.adviceNotice = 'Advisor output'
    LOCALES.en.adviceReplaced = 'Replaces the previous advice'
    LOCALES.en.adviceCollapse = 'Collapse'
    LOCALES.en.adviceExpand = 'Show reference advice'
    LOCALES.en.reviewTitle = 'MoA end-of-turn review'
    LOCALES.en.reviewNotice = 'QA findings'
    LOCALES.en.reviewExpand = 'Show review'

    const inject = ['slots', 'locale', 'remote', 'remote.llm', 'remote.credentials', 'remote.session', 'configForms']

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, LOCALES), 'better-moa: dictionaries')
      if (typeof document !== 'undefined') {
        const style = document.createElement('style')
        style.dataset.moaSettings = ''
        style.textContent = CSS
        document.head.append(style)
        ctx.effect(() => () => style.remove(), 'better-moa: styles')
      }
      const store = new MoaSettingsStore(ctx)
      ctx.effect(() => () => store.dispose(), 'better-moa: settings store')
      if (typeof ctx.remote.$on === 'function') {
        for (const event of ['llm/adapters-updated', 'settings/document-updated', 'credentials/record-updated', 'credentials/reference-updated']) {
          ctx.effect(() => ctx.remote.$on(event, () => store.loadCatalog()), `better-moa: catalog invalidation ${event}`)
        }
      }
      ctx.effect(() => ctx.on('connection/reset', () => {
        store.loadCatalog().catch(() => {})
      }), 'better-moa: connection generation')
      const face = () => ({
        hooks: { moaSettings: store },
        store,
        reload: () => store.reload(),
        loadCatalog: () => store.loadCatalog(),
      })
      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'moa', order: 35,
        label: () => t('nav'), locale: NS, inject: face,
      }, MoaSettingsSection)), 'better-moa: settings section')
      ctx.effect(async () => {
        try {
          // Official package-local lazy chunk: no relative require(), no second
          // plugin package, and no ownership claim over Chat's user/context keys.
          const renderer = await require.async('./client.advice-renderer.js')
          const tAdvice = ctx.locale.bind(NS)
          // Client inject only orders module activation; public services are
          // obtained through ctx.get(), not undeclared Context properties.
          const registrationContext = {
            uiConversation: ctx.get('uiConversation'),
            slots: ctx.get('slots'),
            effect: ctx.effect.bind(ctx),
          }
          const disposeDefinition = renderer.registerAdviceDefinition(registrationContext)
          const disposeView = renderer.registerAdviceRenderer(registrationContext,
            (props) => AdviceCard({ ...renderer.adviceViewProps(props.node), t: tAdvice }), { locale: NS })
          console.log('[Better MoA] advice renderer registered')
          return async () => {
            if (typeof disposeView === 'function') await disposeView()
            if (typeof disposeDefinition === 'function') await disposeDefinition()
          }
        } catch (error) {
          console.error('[Better MoA] advice renderer registration failed', error)
        }
      }, 'better-moa: advice chat renderer')
    }

    exports.NS = NS
    exports.SETTINGS_NS = SETTINGS_NS
    exports.LOCALES = LOCALES
    exports.MoaSettingsStore = MoaSettingsStore
    exports.MoaSettingsSection = MoaSettingsSection
    exports.AdviceCard = AdviceCard
    exports.PresetEditor = PresetEditor
    exports.apply = apply
    exports.inject = inject
    exports.__test = {
      draftFromValue, buildPresetOverrides, buildConfigPatch, validateDraft, validateDecision,
      normalizeFanout, normalizeCatalogGroups, draftSignature, effortSupport, findModel,
      normalizeEffortMode, normalizeDecisionDraft, buildDecision, buildAggregator,
      normalizeSessionPolicy, SESSION_POLICY_VALUES,
      emptyDecisionDraft, DECISION_DEFAULTS, SCHEDULER_LIMITS, AUTOSAVE_DEBOUNCE_MS, testDecisionConnection,
      emptyReferenceDraft, normalizeReferenceDraft,
      setCatalogTimeoutMs(value) { catalogTimeoutMs = value },
      getCatalogTimeoutMs() { return catalogTimeoutMs },
    }
    return module.exports
  },
})