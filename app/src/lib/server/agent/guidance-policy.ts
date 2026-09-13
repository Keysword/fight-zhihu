import { ModelClientError } from './model-client';

export type GuidancePolicyMode = 'legacy' | 'fast';

export interface GuidancePolicy {
	mode: GuidancePolicyMode;
	runBudgetMs: number;
	modelTimeoutMs: number;
	maxModelRetries: number;
	searchTimeoutMs: number;
	maxSearches: number;
	maxModelSteps: number;
}

/** fast 策略默认值：整轮 60s、单次模型 40s、最多补 1 次重试、1 次限时搜索、3 步逻辑上限。 */
export const FAST_GUIDANCE_POLICY: GuidancePolicy = {
	mode: 'fast',
	runBudgetMs: 60_000,
	modelTimeoutMs: 40_000,
	maxModelRetries: 1,
	searchTimeoutMs: 8_000,
	maxSearches: 1,
	maxModelSteps: 3
};

/** legacy 策略保留旧行为：整轮 240s、模型 90s、最多补 2 次重试。 */
export const LEGACY_GUIDANCE_POLICY: GuidancePolicy = {
	mode: 'legacy',
	runBudgetMs: 240_000,
	modelTimeoutMs: 90_000,
	maxModelRetries: 2,
	searchTimeoutMs: 8_000,
	maxSearches: 2,
	maxModelSteps: 5
};

export class GuidancePolicyConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'GuidancePolicyConfigurationError';
	}
}

function parsePositiveInteger(value: string | undefined): number | null {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function override(
	values: Record<string, string | undefined>,
	name: string,
	fallback: number,
	mode: GuidancePolicyMode,
	strictNumeric: boolean
): number {
	const raw = values[name];
	if (raw === undefined || raw === '') return fallback;
	const parsed = parsePositiveInteger(raw);
	if (parsed === null) {
		// 非法显式覆盖在 fast/sdk 配置下报明确配置错误，禁止静默回退到更慢路由。
		if (mode === 'fast' || strictNumeric) {
			throw new GuidancePolicyConfigurationError(`${name} 配置无效：${raw}（需要正整数毫秒值）`);
		}
		return fallback;
	}
	return parsed;
}

/**
 * 解析专用 Agent 策略。legacy 完全保留旧默认与宽容覆盖语义；
 * fast 使用 60/40/1/8s/1 次/3 步，非法覆盖直接报错。
 * strictNumeric 在 AGENT_TRANSPORT=sdk 时开启：即使 legacy 也拒绝非法数值覆盖。
 */
export function resolveGuidancePolicy(
	values: Record<string, string | undefined>,
	options: { strictNumeric?: boolean } = {}
): GuidancePolicy {
	const rawMode = values.GUIDANCE_POLICY;
	if (rawMode !== undefined && rawMode !== '' && rawMode !== 'legacy' && rawMode !== 'fast') {
		throw new GuidancePolicyConfigurationError(
			`GUIDANCE_POLICY 配置无效：${rawMode}（仅支持 legacy 或 fast）`
		);
	}
	const mode: GuidancePolicyMode = rawMode === 'fast' ? 'fast' : 'legacy';
	const strictNumeric = options.strictNumeric === true;
	const base = mode === 'fast' ? FAST_GUIDANCE_POLICY : LEGACY_GUIDANCE_POLICY;
	return {
		mode,
		runBudgetMs: override(values, 'GUIDANCE_RUN_BUDGET_MS', base.runBudgetMs, mode, strictNumeric),
		modelTimeoutMs: override(
			values,
			'GUIDANCE_MODEL_TIMEOUT_MS',
			base.modelTimeoutMs,
			mode,
			strictNumeric
		),
		maxModelRetries: override(
			values,
			'GUIDANCE_MODEL_MAX_RETRIES',
			base.maxModelRetries,
			mode,
			strictNumeric
		),
		searchTimeoutMs: override(
			values,
			'GUIDANCE_SEARCH_TIMEOUT_MS',
			base.searchTimeoutMs,
			mode,
			strictNumeric
		),
		maxSearches: override(values, 'GUIDANCE_MAX_SEARCHES', base.maxSearches, mode, strictNumeric),
		maxModelSteps: override(
			values,
			'GUIDANCE_MAX_MODEL_STEPS',
			base.maxModelSteps,
			mode,
			strictNumeric
		)
	};
}

const FAST_RETRY_BACKOFF_MS = 200;

/**
 * fast 模式的重试判断：只针对网络抖动与 5xx/429 之外的快速失败，
 * 超时、取消、401/429、预算不足一律不重试。attemptMs 超过 3 秒的慢失败也不重试。
 */
export function canRetryFast(
	error: unknown,
	attemptMs: number,
	remainingMs: number,
	retriesUsed: number,
	maxRetries: number
): boolean {
	if (!(error instanceof ModelClientError)) return false;
	if (retriesUsed >= maxRetries || remainingMs < 10_000 || attemptMs > 3_000) return false;
	return (
		error.reason === 'network' ||
		(error.reason === 'http' && error.status !== null && error.status >= 500)
	);
}

/** fast 固定 200ms 退避，并受剩余预算控制。 */
export function fastBackoffDelayMs(remainingMs: number): number | null {
	if (remainingMs < FAST_RETRY_BACKOFF_MS + 10_000) return null;
	return FAST_RETRY_BACKOFF_MS;
}
