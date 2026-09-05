export interface RateLimitPolicy {
	maximum: number;
	windowMs: number;
}

export class RateLimitExceededError extends Error {
	constructor(readonly retryAfterSeconds: number) {
		super(`请求过于频繁，请在 ${retryAfterSeconds} 秒后再试`);
		this.name = 'RateLimitExceededError';
	}
}

const attempts = new Map<string, number[]>();

function clientAddress(request: Request): string {
	return (
		request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
		request.headers.get('x-real-ip')?.trim() ||
		'unknown'
	);
}

export function assertRateLimit(
	request: Request,
	scope: string,
	policy: RateLimitPolicy,
	now = Date.now()
): void {
	const key = `${scope}:${clientAddress(request)}`;
	const cutoff = now - policy.windowMs;
	const recent = (attempts.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
	if (recent.length >= policy.maximum) {
		const retryAt = recent[0] + policy.windowMs;
		throw new RateLimitExceededError(Math.max(1, Math.ceil((retryAt - now) / 1_000)));
	}
	recent.push(now);
	attempts.set(key, recent);

	if (attempts.size > 2_000) {
		for (const [candidate, timestamps] of attempts) {
			if (timestamps.every((timestamp) => timestamp <= cutoff)) attempts.delete(candidate);
		}
	}
}

export function resetRateLimitsForTest(): void {
	attempts.clear();
}
