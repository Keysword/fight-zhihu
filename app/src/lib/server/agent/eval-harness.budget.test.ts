import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	BudgetExhaustedError,
	EvalSession,
	overrideDataDirectoryForTests
} from '../../../../evals/guidance/harness';

const directories: string[] = [];
const previousEnv: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined): void {
	if (!(name in previousEnv)) previousEnv[name] = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

afterEach(() => {
	overrideDataDirectoryForTests(null as never);
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
	for (const [name, value] of Object.entries(previousEnv)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	for (const name of Object.keys(previousEnv)) delete previousEnv[name];
});

function freshLedgerDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), 'eval-ledger-'));
	directories.push(directory);
	overrideDataDirectoryForTests(directory);
	return directory;
}

describe('evaluation request budget ledger (offline)', () => {
	it('honours GUIDANCE_EVAL_MAX_REQUESTS=1: the second reserve must fail', () => {
		freshLedgerDirectory();
		setEnv('GUIDANCE_EVAL_MAX_REQUESTS', '1');
		const session = new EvalSession({ phase: 'policy' });
		expect(session.remainingModelRequests).toBe(1);
		session.reserveModelRequests(1);
		expect(() => session.reserveModelRequests(1)).toThrow(BudgetExhaustedError);
	});

	it('rejects an invalid GUIDANCE_EVAL_MAX_REQUESTS instead of silently raising the limit', () => {
		freshLedgerDirectory();
		setEnv('GUIDANCE_EVAL_MAX_REQUESTS', 'many');
		expect(() => new EvalSession({ phase: 'policy' })).toThrow(
			/GUIDANCE_EVAL_MAX_REQUESTS 配置无效/
		);
	});

	it('uses the smallest of explicit option, env limit and global remaining', () => {
		freshLedgerDirectory();
		setEnv('GUIDANCE_EVAL_MODEL_LIMIT', '10');
		setEnv('GUIDANCE_EVAL_MAX_REQUESTS', '4');
		const session = new EvalSession({ phase: 'policy', maxModelRequests: 2 });
		expect(session.remainingModelRequests).toBe(2);
		const another = new EvalSession({ phase: 'policy' });
		expect(another.remainingModelRequests).toBe(4);
	});

	it('keeps counting across sessions: a new session cannot bypass the global ledger', () => {
		freshLedgerDirectory();
		setEnv('GUIDANCE_EVAL_MODEL_LIMIT', '3');
		delete process.env.GUIDANCE_EVAL_MAX_REQUESTS;
		const first = new EvalSession({ phase: 'transport' });
		first.reserveModelRequests(2);
		const second = new EvalSession({ phase: 'transport' });
		expect(second.remainingModelRequests).toBe(1);
		second.reserveModelRequests(1);
		expect(() => second.reserveModelRequests(1)).toThrow(BudgetExhaustedError);
		// ledger 落盘累计，而非会话内存。
		const session3 = new EvalSession({ phase: 'transport' });
		expect(session3.remainingModelRequests).toBe(0);
	});

	it('fails also count against the budget', () => {
		freshLedgerDirectory();
		setEnv('GUIDANCE_EVAL_MAX_REQUESTS', '2');
		const session = new EvalSession({ phase: 'transport' });
		session.reserveModelRequests(1);
		session.reserveModelRequests(1);
		expect(session.remainingModelRequests).toBe(0);
	});

	it('tracks the search budget separately', () => {
		freshLedgerDirectory();
		setEnv('GUIDANCE_EVAL_MAX_SEARCH_REQUESTS', '1');
		const session = new EvalSession({ phase: 'search' });
		session.reserveSearchRequests(1);
		expect(() => session.reserveSearchRequests(1)).toThrow(BudgetExhaustedError);
		expect(session.remainingModelRequests).toBeGreaterThan(0);
	});
});

describe('eval runtime factory contract', () => {
	it('passes policyMode through so fast-labelled evals really run the fast policy', async () => {
		const { createEvalRuntimeDependencies } = await import('../../../../evals/guidance/harness');
		const { resolveGuidancePolicy } = await import('./guidance-policy');
		const { mkdtempSync: mkdtemp } = await import('node:fs');
		const { createCaseRepository } = await import('$lib/server/cases/repository');

		const directory = mkdtemp(join(tmpdir(), 'eval-contract-'));
		directories.push(directory);
		const repository = createCaseRepository(join(directory, 'contract.sqlite'));
		const created = repository.createCase({
			title: '契约案例',
			goal: '验证评测工厂传递 policyMode',
			confusion: 'fast 行为是否生效？'
		});
		const { ModelClientError } = await import('./model-client');
		let calls = 0;
		const model = {
			complete: vi.fn(async () => {
				calls += 1;
				throw new ModelClientError('Agent 模型响应超时', { reason: 'timeout' });
			})
		};
		const policy = resolveGuidancePolicy({ GUIDANCE_POLICY: 'fast' });
		const runtime = createEvalRuntimeDependencies({
			repository,
			model: model as never,
			policy,
			zhihu: {
				searchZhihu: async () => [],
				searchGlobal: async () => []
			}
		});
		const result = await runtime.run(created.id);
		// fast 策略：timeout 不重试 → 恰好 1 次模型调用并失败。
		expect(result.outcome).toBe('failed');
		expect(calls).toBe(1);
	});

	it('runs the legacy retry contract when the policy mode is legacy', async () => {
		const { createEvalRuntimeDependencies } = await import('../../../../evals/guidance/harness');
		const { LEGACY_GUIDANCE_POLICY } = await import('./guidance-policy');
		const { mkdtempSync: mkdtemp } = await import('node:fs');
		const { createCaseRepository } = await import('$lib/server/cases/repository');
		const { ModelClientError } = await import('./model-client');

		const directory = mkdtemp(join(tmpdir(), 'eval-contract-legacy-'));
		directories.push(directory);
		const repository = createCaseRepository(join(directory, 'contract.sqlite'));
		const created = repository.createCase({
			title: '契约案例 legacy',
			goal: '验证 legacy 模式保留原重试契约',
			confusion: '超时后是否重试？'
		});
		let calls = 0;
		const model = {
			complete: vi.fn(async () => {
				calls += 1;
				throw new ModelClientError('Agent 模型响应超时', { reason: 'timeout' });
			})
		};
		const runtime = createEvalRuntimeDependencies({
			repository,
			model: model as never,
			policy: LEGACY_GUIDANCE_POLICY,
			zhihu: {
				searchZhihu: async () => [],
				searchGlobal: async () => []
			}
		});
		const result = await runtime.run(created.id);
		// legacy：timeout 可重试，2 次重试后共 3 次尝试。
		expect(result.outcome).toBe('failed');
		expect(calls).toBe(3);
	});
});
