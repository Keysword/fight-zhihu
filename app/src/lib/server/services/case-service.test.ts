import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCaseRepository, CaseNotFoundError } from '$lib/server/cases/repository';
import { createCaseService } from './case-service';

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function setup() {
	const directory = mkdtempSync(join(tmpdir(), 'background-service-'));
	directories.push(directory);
	const repository = createCaseRepository(join(directory, 'service.sqlite'));
	const runner = {
		run: vi.fn(async () => ({
			outcome: 'finished' as const,
			summary: '完成',
			turns: 1,
			revision: 0
		}))
	};
	const service = createCaseService({
		repository,
		runner,
		configuration: { modelConfigured: true, zhihuConfigured: true, version: 'test' }
	});
	return { repository, runner, service };
}

describe('case service', () => {
	it('redacts sensitive input before persistence', () => {
		const { repository, service } = setup();
		const result = service.createCase({
			title: '入职手续',
			goal: '确认材料',
			confusion: '赵老师让我拨打 13812345678，但没有说材料清单',
			replacements: [{ from: '赵老师', to: '人力老师' }],
			evidence: [
				{ kind: 'email', content: '发送到 a@example.com', sourceLabel: '通知', occurredAt: null }
			]
		});

		expect(result.case.confusion).toBe('人力老师让我拨打 [手机号]，但没有说材料清单');
		expect(result.case.evidence[0].content).toBe('发送到 [邮箱]');
		expect(result.redactionCount).toBe(3);
		expect(JSON.stringify(result)).not.toContain('13812345678');
		repository.close();
	});

	it('creates and runs the marked dorm demonstration', async () => {
		const { repository, runner, service } = setup();
		const result = await service.createDemo();
		expect(result.case.evidence).toHaveLength(4);
		expect(result.case.board?.keyCompleter?.participantId).toBe('participant-hr');
		expect(result.events.some((event) => event.type === 'case.demo')).toBe(true);
		expect(result.events.some((event) => event.type === 'agent.fallback')).toBe(true);
		expect(runner.run).toHaveBeenCalledWith(result.case.id);
		repository.close();
	});

	it('appends evidence, runs the same case, and hides internal configuration', async () => {
		const { repository, runner, service } = setup();
		const created = service.createCase({
			title: '入职',
			goal: '完成手续',
			confusion: '不知道找谁'
		});
		const result = await service.appendEvidenceAndRun(created.case.id, {
			kind: 'message',
			content: '找部门 HR',
			sourceLabel: '同事',
			occurredAt: null
		});
		expect(result.case.evidence).toHaveLength(1);
		expect(runner.run).toHaveBeenCalledWith(created.case.id);
		expect(JSON.stringify(service.getCase(created.case.id))).not.toMatch(
			/API_KEY|ACCESS_SECRET|messages/i
		);
		repository.close();
	});

	it('returns health flags and rejects unknown case IDs', () => {
		const { repository, service } = setup();
		expect(service.health()).toEqual({
			version: 'test',
			databaseReady: true,
			modelConfigured: true,
			zhihuConfigured: true
		});
		expect(() => service.getCase('missing')).toThrow(CaseNotFoundError);
		repository.close();
	});
});
