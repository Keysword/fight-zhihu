import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';

// 独立评测配置：只由 `pnpm eval:guidance:latency --config vitest.eval.config.ts` 使用，
// 不进入默认单测。真实凭证通过 shell 环境或 app/.env.eval（0600，gitignored）注入。
export default defineConfig({
	plugins: [sveltekit()],
	test: {
		expect: { requireAssertions: true },
		environment: 'node',
		include: ['evals/**/*.test.ts'],
		// 真实模型请求可能超过默认 5 秒；单样本仍受整轮预算约束。
		testTimeout: 300_000,
		hookTimeout: 120_000,
		// 串行执行，避免并发抢占影响延迟归因。
		maxWorkers: 1,
		fileParallelism: false
	}
});
