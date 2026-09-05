import { describe, expect, it } from 'vitest';

import { assertRateLimit, RateLimitExceededError, resetRateLimitsForTest } from './rate-limit';

describe('in-memory request rate limiter', () => {
	it('limits one client and scope without affecting another', () => {
		resetRateLimitsForTest();
		const first = new Request('https://example.test', {
			headers: { 'x-forwarded-for': '203.0.113.4' }
		});
		const second = new Request('https://example.test', {
			headers: { 'x-forwarded-for': '203.0.113.5' }
		});
		assertRateLimit(first, 'agent-run', { maximum: 2, windowMs: 60_000 }, 1_000);
		assertRateLimit(first, 'agent-run', { maximum: 2, windowMs: 60_000 }, 2_000);
		expect(() =>
			assertRateLimit(first, 'agent-run', { maximum: 2, windowMs: 60_000 }, 3_000)
		).toThrow(RateLimitExceededError);
		expect(() =>
			assertRateLimit(second, 'agent-run', { maximum: 2, windowMs: 60_000 }, 3_000)
		).not.toThrow();
	});

	it('allows requests again after the window expires', () => {
		resetRateLimitsForTest();
		const request = new Request('https://example.test');
		assertRateLimit(request, 'demo', { maximum: 1, windowMs: 1_000 }, 1_000);
		expect(() =>
			assertRateLimit(request, 'demo', { maximum: 1, windowMs: 1_000 }, 2_001)
		).not.toThrow();
	});
});
