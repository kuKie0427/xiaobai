// Capsules have room for an icon and a two-character status. Details stay
// outside; numeric progress keeps its own formatting across providers.
export const DRAW_CAPSULE_COPY = Object.freeze({
    submitting: '提交',
    uncertain: '确认',
    unknown: '未知',
    queued: '排队',
    analysis: '分析',
    correction: '纠错',
    retry: '重试',
    reattaching: '接回',
    preparing: '准备',
    reconnecting: '重连',
    cooldown: '等待',
    generating: '生成',
    cancelling: '取消',
    legacy: '兼容',
    error: '失败',
});

/**
 * Agent 请求失败后的重试：有“第几次 / 共几次”就显示 `重2/3`，否则只显示“重试”。
 * 胶囊只有 74px，扣掉图标和边距后放不下 `重试1/3`（会被省略号截成 `重试1…`），所以带次数时压成单字“重”。
 */
export function formatPlannerRetryProgress(current, total) {
    const attempt = Number(current);
    const limit = Number(total);
    return Number.isInteger(attempt) && attempt > 0 && Number.isInteger(limit) && limit >= attempt
        ? `${DRAW_CAPSULE_COPY.retry.slice(0, 1)}${attempt}/${limit}`
        : DRAW_CAPSULE_COPY.retry;
}
