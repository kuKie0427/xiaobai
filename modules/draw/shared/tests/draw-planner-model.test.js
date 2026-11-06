// 生图规划模型独立配置（plannerModel，mode = follow / custom）的解析行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDrawAgentProviderConfig } from '../draw-agent.js';
import {
    normalizePlannerModelConfig,
    isCustomPlannerModelConfig,
} from '../draw-settings.js';

function buildAgentSettings(model = 'main-model') {
    return {
        currentPresetName: '主预设',
        presets: {
            主预设: {
                provider: 'openai-compatible',
                modelConfigs: {
                    'openai-compatible': {
                        baseUrl: 'https://main.example/v1',
                        model,
                        apiKey: 'main-key',
                        temperature: 0.4,
                        maxTokens: 4567,
                        toolMode: 'native',
                    },
                },
            },
        },
    };
}

function buildCustomConfig(overrides = {}) {
    return {
        mode: 'custom',
        provider: 'openai-compatible',
        baseUrl: 'https://planner.example/v1',
        apiKey: 'planner-key',
        model: 'planner-model',
        temperature: 0.2,
        maxTokens: 2048,
        toolMode: 'native',
        ...overrides,
    };
}

test('planner model config 默认跟随：不提供 plannerModel 时走共享主预设', async () => {
    const { providerConfig } = await resolveDrawAgentProviderConfig({
        dependencies: {
            getAgentSettings: async () => buildAgentSettings('main-model'),
            getPlannerModelConfig: async () => null,
        },
    });
    assert.equal(providerConfig.model, 'main-model');
    assert.equal(providerConfig.apiKey, 'main-key');
});

test('planner model config mode=follow 时即使配置了字段也走共享主预设', async () => {
    const { providerConfig } = await resolveDrawAgentProviderConfig({
        dependencies: {
            getAgentSettings: async () => buildAgentSettings('main-model'),
            getPlannerModelConfig: async () => buildCustomConfig({ mode: 'follow' }),
        },
    });
    assert.equal(providerConfig.model, 'main-model');
});

test('planner model config mode=custom 时使用独立配置而不是共享主预设', async () => {
    const { providerConfig } = await resolveDrawAgentProviderConfig({
        dependencies: {
            getAgentSettings: async () => buildAgentSettings('main-model'),
            getPlannerModelConfig: async () => buildCustomConfig(),
        },
    });
    assert.equal(providerConfig.provider, 'openai-compatible');
    assert.equal(providerConfig.baseUrl, 'https://planner.example/v1');
    assert.equal(providerConfig.apiKey, 'planner-key');
    assert.equal(providerConfig.model, 'planner-model');
    assert.equal(providerConfig.temperature, 0.2);
    assert.equal(providerConfig.maxTokens, 2048);
    assert.equal(providerConfig.currentPresetName, '生图规划模型');
});

test('planner model config mode=custom 缺模型时报 MODEL_MISSING', async () => {
    await assert.rejects(
        resolveDrawAgentProviderConfig({
            dependencies: {
                getAgentSettings: async () => buildAgentSettings(),
                getPlannerModelConfig: async () => buildCustomConfig({ model: '' }),
            },
        }),
        (error) => error.code === 'MODEL_MISSING' && /生图规划模型配置尚未选择模型/.test(error.message),
    );
});

test('planner model config mode=custom 非酒馆 provider 缺 key 时报 API_KEY_MISSING', async () => {
    await assert.rejects(
        resolveDrawAgentProviderConfig({
            dependencies: {
                getAgentSettings: async () => buildAgentSettings(),
                getPlannerModelConfig: async () => buildCustomConfig({ apiKey: '' }),
            },
        }),
        (error) => error.code === 'API_KEY_MISSING' && /生图规划模型配置缺少 API Key/.test(error.message),
    );
});

test('planner model config mode=custom 酒馆 provider 不要求 API Key', async () => {
    const { providerConfig } = await resolveDrawAgentProviderConfig({
        dependencies: {
            getAgentSettings: async () => buildAgentSettings(),
            getPlannerModelConfig: async () => buildCustomConfig({
                provider: 'sillytavern-vertex',
                apiKey: '',
                baseUrl: '',
                model: 'host-model',
            }),
        },
    });
    assert.equal(providerConfig.provider, 'sillytavern-vertex');
    assert.equal(providerConfig.model, 'host-model');
});

test('planner model config mode=custom 读取失败时报 AGENT_SETTINGS_LOAD_FAILED', async () => {
    await assert.rejects(
        resolveDrawAgentProviderConfig({
            dependencies: {
                getAgentSettings: async () => buildAgentSettings(),
                getPlannerModelConfig: async () => { throw new Error('boom'); },
            },
        }),
        (error) => error.code === 'AGENT_SETTINGS_LOAD_FAILED' && /生图规划模型配置读取失败/.test(error.message),
    );
});

test('normalizePlannerModelConfig 非法值回落默认且只认 follow/custom', () => {
    assert.equal(normalizePlannerModelConfig(null).mode, 'follow');
    assert.equal(normalizePlannerModelConfig({ mode: 'whatever' }).mode, 'follow');
    assert.equal(normalizePlannerModelConfig({ mode: 'custom' }).mode, 'custom');
    assert.equal(isCustomPlannerModelConfig({ mode: 'custom' }), true);
    assert.equal(isCustomPlannerModelConfig({}), false);
    const normalized = normalizePlannerModelConfig({ provider: 'not-a-provider', temperature: 9, maxTokens: -5 });
    // 默认走酒馆后端转发：浏览器里直连类接口会撞 CORS
    assert.equal(normalized.provider, 'sillytavern-openai-compatible');
    assert.equal(normalized.temperature, 2);
    assert.equal(normalized.maxTokens, 0);
});

test('normalizePlannerModelConfig temperature/maxTokens 边界收敛', () => {
    const normalized = normalizePlannerModelConfig({ temperature: -1, maxTokens: 3000 });
    assert.equal(normalized.temperature, 0);
    assert.equal(normalized.maxTokens, 3000);
});
