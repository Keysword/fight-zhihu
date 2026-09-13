import { describe, expect, it } from 'vitest';

import { ModelClientError } from './model-client';
import {
	canRetryFast,
	fastBackoffDelayMs,
	GuidancePolicyConfigurationError,
	resolveGuidancePolicy
} from './guidance-policy';

describe('guidance policy resolution', () => {
	it('defaults to legacy behaviour when GUIDANCE_POLICY is unset', () => {
		const policy = resolveGuidancePolicy({});
		expect(policy.mode).toBe('legacy');
		expect(policy.runBudgetMs).toBe(240_000);
		expect(policy.modelTimeoutMs).toBe(90_000);
		expect(policy.maxModelRetries).toBe(2);
		expect(policy.maxModelSteps).toBe(5);
	});

	it('uses fast defaults only for fast mode', () => {
		const policy = resolveGuidancePolicy({ GUIDANCE_POLICY: 'fast' });
		expect(policy.mode).toBe('fast');
		expect(policy.runBudgetMs).toBe(60_000);
		expect(policy.modelTimeoutMs).toBe(40_000);
		expect(policy.maxModelRetries).toBe(1);
		expect(policy.searchTimeoutMs).toBe(8_000);
		expect(policy.maxSearches).toBe(1);
		expect(policy.maxModelSteps).toBe(3);
	});

	it('honours explicit numeric overrides in both modes', () => {
		const policy = resolveGuidancePolicy({
			GUIDANCE_POLICY: 'fast',
			GUIDANCE_RUN_BUDGET_MS: '45000',
			GUIDANCE_MODEL_TIMEOUT_MS: '30000'
		});
		expect(policy.runBudgetMs).toBe(45_000);
		expect(policy.modelTimeoutMs).toBe(30_000);
	});

	it('rejects invalid overrides under fast mode instead of silently slowing down', () => {
		expect(() =>
			resolveGuidancePolicy({ GUIDANCE_POLICY: 'fast', GUIDANCE_RUN_BUDGET_MS: 'soon' })
		).toThrow(GuidancePolicyConfigurationError);
	});

	it('rejects invalid overrides under sdk transport even in legacy mode', () => {
		expect(() =>
			resolveGuidancePolicy({ GUIDANCE_MODEL_TIMEOUT_MS: '90s' }, { strictNumeric: true })
		).toThrow(GuidancePolicyConfigurationError);
	});

	it('keeps the legacy lenient override semantics without sdk transport', () => {
		const policy = resolveGuidancePolicy({ GUIDANCE_RUN_BUDGET_MS: 'soon' });
		expect(policy.runBudgetMs).toBe(240_000);
	});

	it('rejects an unknown policy mode', () => {
		expect(() => resolveGuidancePolicy({ GUIDANCE_POLICY: 'turbo' })).toThrow(
			GuidancePolicyConfigurationError
		);
	});
});

describe('fast retry decision', () => {
	const networkError = () => new ModelClientError('网络失败', { reason: 'network' });
	const timeoutError = () => new ModelClientError('超时', { reason: 'timeout' });
	const cancelledError = () => new ModelClientError('取消', { reason: 'cancelled' });
	const unauthorized = () => new ModelClientError('未授权', { reason: 'http', status: 401 });
	const rateLimited = () => new ModelClientError('限流', { reason: 'http', status: 429 });
	const serverError = () => new ModelClientError('服务器错误', { reason: 'http', status: 503 });

	it('retries a fast network failure once', () => {
		expect(canRetryFast(networkError(), 500, 30_000, 0, 1)).toBe(true);
		expect(canRetryFast(networkError(), 500, 30_000, 1, 1)).toBe(false);
	});

	it('retries a fast 503 but not 401 or 429', () => {
		expect(canRetryFast(serverError(), 500, 30_000, 0, 1)).toBe(true);
		expect(canRetryFast(unauthorized(), 500, 30_000, 0, 1)).toBe(false);
		expect(canRetryFast(rateLimited(), 500, 30_000, 0, 1)).toBe(false);
	});

	it('never retries timeout or cancellation', () => {
		expect(canRetryFast(timeoutError(), 500, 30_000, 0, 1)).toBe(false);
		expect(canRetryFast(cancelledError(), 500, 30_000, 0, 1)).toBe(false);
	});

	it('refuses to retry when the remaining budget is under 10 seconds', () => {
		expect(canRetryFast(networkError(), 500, 9_999, 0, 1)).toBe(false);
		expect(canRetryFast(networkError(), 500, 10_000, 0, 1)).toBe(true);
	});

	it('refuses to retry slow attempts', () => {
		expect(canRetryFast(networkError(), 3_001, 30_000, 0, 1)).toBe(false);
		expect(canRetryFast(networkError(), 3_000, 30_000, 0, 1)).toBe(true);
	});
});

describe('fast backoff', () => {
	it('uses a fixed 200ms backoff bounded by the remaining budget', () => {
		expect(fastBackoffDelayMs(30_000)).toBe(200);
		expect(fastBackoffDelayMs(10_100)).toBeNull();
	});
});
