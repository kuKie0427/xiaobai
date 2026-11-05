import { ScenePlannerError } from './scene-plan-contract.js';
import { normalizeAgentConfig } from '../../agent-core/config.js';
import {
    isSillyTavernProvider,
    resolveActiveProviderConfig,
} from '../../agent-core/provider-resolution.js';
import { normalizePlannerModelConfig } from './draw-settings.js';
import {
    assertDrawScenePlannerTask,
    beginDrawScenePlannerDiagnostic,
    callDrawScenePlannerAgentRuntime,
    getLastDrawAgentDiagnostic,
    normalizeScenePlannerTimeout,
    resetDrawAgentRuntimeForTests as resetPureDrawAgentRuntimeForTests,
} from './draw-agent-runtime.js';

const AGENT_SETTINGS_FILE_KEY = 'settings';

let agentCoreModulePromise = null;
let agentSettingsReaderPromise = null;
let requestHeadersProviderPromise = null;

async function loadDefaultAgentSettingsReader() {
    agentSettingsReaderPromise ||= import('../../../core/server-storage.js')
        .then((storageModule) => () => storageModule.AssistantStorage.get(AGENT_SETTINGS_FILE_KEY, null))
        .catch((error) => {
            agentSettingsReaderPromise = null;
            throw error;
        });
    return agentSettingsReaderPromise;
}

async function loadDefaultRequestHeadersProvider() {
    requestHeadersProviderPromise ||= import('../../../../../../../script.js')
        .then((hostModule) => () => hostModule.getRequestHeaders())
        .catch((error) => {
            requestHeadersProviderPromise = null;
            throw error;
        });
    return requestHeadersProviderPromise;
}

export async function loadAgentCoreBrowser() {
    agentCoreModulePromise ||= import('../../agent-core/dist/agent-core-browser.js');
    try {
        return await agentCoreModulePromise;
    } catch (error) {
        agentCoreModulePromise = null;
        throw new ScenePlannerError(
            `AgentCore 浏览器组件加载失败：${error?.message || '未知错误'}`,
            'AGENT_CORE_LOAD_FAILED',
            null,
            { cause: error },
        );
    }
}

async function readAgentSettings(overrides = {}) {
    try {
        const reader = typeof overrides.getAgentSettings === 'function'
            ? overrides.getAgentSettings
            : await loadDefaultAgentSettingsReader();
        return await reader();
    } catch (error) {
        throw new ScenePlannerError(
            `共享 Agent 设置读取失败：${error?.message || '未知错误'}`,
            'AGENT_SETTINGS_LOAD_FAILED',
            null,
            { cause: error },
        );
    }
}

function assertCurrentPreset(rawSettings, normalizedSettings) {
    if (!rawSettings || typeof rawSettings !== 'object' || Array.isArray(rawSettings)) return;
    const requestedName = String(rawSettings.currentPresetName || '').trim();
    const rawPresets = rawSettings.presets;
    const hasRequestedPreset = rawPresets
        && typeof rawPresets === 'object'
        && !Array.isArray(rawPresets)
        && Object.prototype.hasOwnProperty.call(rawPresets, requestedName);
    if (requestedName && !hasRequestedPreset) {
        throw new ScenePlannerError(
            `共享 Agent 当前主预设「${requestedName}」不存在。`,
            'AGENT_PRESET_INVALID',
        );
    }
    const normalizedName = String(normalizedSettings?.currentPresetName || '').trim();
    if (!normalizedName || !normalizedSettings?.presets?.[normalizedName]) {
        throw new ScenePlannerError('共享 Agent 当前主预设无法解析。', 'AGENT_PRESET_INVALID');
    }
}

function resolveDrawProviderConfig(rawSettings, timeout) {
    let settings;
    let providerConfig;
    try {
        settings = normalizeAgentConfig(rawSettings || {});
        assertCurrentPreset(rawSettings, settings);
        providerConfig = resolveActiveProviderConfig(settings, {
            timeoutMs: normalizeScenePlannerTimeout(timeout),
        });
        providerConfig = {
            ...providerConfig,
            reasoning: {
                ...providerConfig.reasoning,
                output: 'hide',
            },
        };
    } catch (error) {
        if (error instanceof ScenePlannerError) throw error;
        throw new ScenePlannerError(
            `共享 Agent 当前主预设无法解析：${error?.message || '未知错误'}`,
            'AGENT_PRESET_INVALID',
            null,
            { cause: error },
        );
    }

    if (!String(providerConfig.model || '').trim()) {
        throw new ScenePlannerError(
            `共享主预设「${providerConfig.currentPresetName || settings.currentPresetName}」尚未选择模型。`,
            'MODEL_MISSING',
        );
    }

    if (!isSillyTavernProvider(providerConfig.provider)
        && !String(providerConfig.apiKey || '').trim()) {
        throw new ScenePlannerError(
            `共享主预设「${providerConfig.currentPresetName || settings.currentPresetName}」缺少 API Key。`,
            'API_KEY_MISSING',
        );
    }

    return { settings, providerConfig };
}

export async function resolveDrawAgentProviderConfig(options = {}) {
    const dependencies = options.dependencies || {};
    const plannerModel = await readPlannerModelConfig(dependencies);
    if (plannerModel.mode === 'custom') {
        return resolveCustomDrawPlannerProviderConfig(plannerModel, options.timeout);
    }
    const rawSettings = await readAgentSettings(dependencies);
    return resolveDrawProviderConfig(rawSettings, options.timeout);
}

// 生图规划的独立模型配置（draw-settings.plannerModel，mode === 'custom' 时启用）。
// 依赖可注入以便测试；默认从共享画图设置读取。
// 默认读取失败（如宿主存储暂不可用）时回落 follow：退回“跟随共享主预设”的旧行为，
// 比让整条规划链路硬失败更安全。注入 getPlannerModelConfig 的调用方错误仍会抛出。
async function readPlannerModelConfig(dependencies = {}) {
    if (typeof dependencies.getPlannerModelConfig === 'function') {
        try {
            return normalizePlannerModelConfig(await dependencies.getPlannerModelConfig());
        } catch (error) {
            throw new ScenePlannerError(
                `生图规划模型配置读取失败：${error?.message || '未知错误'}`,
                'AGENT_SETTINGS_LOAD_FAILED',
                null,
                { cause: error },
            );
        }
    }
    try {
        const settings = await import('./draw-settings.js').then((module) => module.loadSharedDrawSettings());
        return normalizePlannerModelConfig(settings?.plannerModel);
    } catch (error) {
        console.warn('[DrawAgent] 生图规划模型配置读取失败，按跟随共享主预设处理:', error);
        return normalizePlannerModelConfig(null);
    }
}

// 把独立配置包装成单预设的 Agent 配置，复用 normalizeAgentConfig / resolveActiveProviderConfig 的全套规范化，
// 与共享主预设走完全相同的解析路径（温度、maxTokens、toolMode、酒馆 provider 专用字段等）。
const CUSTOM_PLANNER_PRESET_NAME = '__draw_planner_model__';

function resolveCustomDrawPlannerProviderConfig(plannerModel, timeout) {
    const providerConfigShape = {
        baseUrl: plannerModel.baseUrl,
        apiKey: plannerModel.apiKey,
        model: plannerModel.model,
        temperature: plannerModel.temperature,
        maxTokens: plannerModel.maxTokens || undefined,
        toolMode: plannerModel.toolMode,
    };
    const rawSettings = {
        presets: { [CUSTOM_PLANNER_PRESET_NAME]: { provider: plannerModel.provider, modelConfigs: { [plannerModel.provider]: providerConfigShape } } },
        currentPresetName: CUSTOM_PLANNER_PRESET_NAME,
    };
    let settings;
    let providerConfig;
    try {
        settings = normalizeAgentConfig(rawSettings);
        providerConfig = resolveActiveProviderConfig(settings, {
            timeoutMs: normalizeScenePlannerTimeout(timeout),
        });
        providerConfig = {
            ...providerConfig,
            reasoning: {
                ...providerConfig.reasoning,
                output: 'hide',
            },
        };
    } catch (error) {
        if (error instanceof ScenePlannerError) throw error;
        throw new ScenePlannerError(
            `生图规划模型配置无效：${error?.message || '未知错误'}`,
            'AGENT_PRESET_INVALID',
            null,
            { cause: error },
        );
    }

    if (!String(providerConfig.model || '').trim()) {
        throw new ScenePlannerError('生图规划模型配置尚未选择模型。', 'MODEL_MISSING');
    }

    if (!isSillyTavernProvider(providerConfig.provider)
        && !String(providerConfig.apiKey || '').trim()) {
        throw new ScenePlannerError('生图规划模型配置缺少 API Key。', 'API_KEY_MISSING');
    }

    return {
        settings,
        providerConfig: {
            ...providerConfig,
            currentPresetName: '生图规划模型',
        },
    };
}

async function loadDrawAgentCoreForProvider(providerConfig, options = {}) {
    const dependencies = options.dependencies || {};
    const loadAgentCore = options.loadAgentCore || loadAgentCoreBrowser;
    let agentCore;
    try {
        agentCore = await loadAgentCore();
    } catch (error) {
        if (error instanceof ScenePlannerError) throw error;
        throw new ScenePlannerError(
            `AgentCore 浏览器组件加载失败：${error?.message || '未知错误'}`,
            'AGENT_CORE_LOAD_FAILED',
            null,
            { cause: error },
        );
    }

    if (isSillyTavernProvider(providerConfig.provider)) {
        try {
            const requestHeadersProvider = typeof dependencies.requestHeadersProvider === 'function'
                ? dependencies.requestHeadersProvider
                : await loadDefaultRequestHeadersProvider();
            agentCore.setHostChatCompletionsRequestHeadersProvider(requestHeadersProvider);
        } catch (error) {
            if (error instanceof ScenePlannerError) throw error;
            throw new ScenePlannerError(
                `酒馆请求头组件加载失败：${error?.message || '未知错误'}`,
                'HOST_REQUEST_HEADERS_LOAD_FAILED',
                null,
                { cause: error },
            );
        }
    }
    return agentCore;
}

export async function resolveDrawAgentContext(options = {}) {
    const { settings, providerConfig } = await resolveDrawAgentProviderConfig(options);
    const agentCore = await loadDrawAgentCoreForProvider(providerConfig, options);
    return { agentCore, settings, providerConfig };
}

export async function callDrawScenePlannerAgent(options = {}) {
    const task = options.task || {};
    const diagnostic = options.diagnostic
        || beginDrawScenePlannerDiagnostic({}, options.onDiagnosticUpdate);
    assertDrawScenePlannerTask(task, diagnostic);
    diagnostic.update({ stage: 'config' });

    let agentCore;
    let providerConfig;
    try {
        if (options.providerConfig && typeof options.providerConfig === 'object') {
            providerConfig = options.providerConfig;
            agentCore = options.agentCore
                || await loadDrawAgentCoreForProvider(providerConfig, options);
        } else {
            ({ agentCore, providerConfig } = await resolveDrawAgentContext(options));
        }
    } catch (error) {
        diagnostic.fail(error, { stage: 'config' });
        throw error;
    }

    return callDrawScenePlannerAgentRuntime({
        ...options,
        task,
        diagnostic,
        agentCore,
        providerConfig,
        diagnosticConfigStarted: true,
    });
}

export {
    beginDrawScenePlannerDiagnostic,
    getLastDrawAgentDiagnostic,
};

export function resetDrawAgentRuntimeForTests() {
    agentCoreModulePromise = null;
    agentSettingsReaderPromise = null;
    requestHeadersProviderPromise = null;
    resetPureDrawAgentRuntimeForTests();
}
