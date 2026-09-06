import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { dormDemoEvidence } from '$lib/domain/demo-case';
import { createCaseRepository } from '$lib/server/cases/repository';
import { buildDormDemoFallback } from './fallback';

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe('dorm demo fallback', () => {
	it('moves the reviewed board from waiting to actionable when property confirms room and key', () => {
		const directory = mkdtempSync(join(tmpdir(), 'background-fallback-'));
		directories.push(directory);
		const repository = createCaseRepository(join(directory, 'fallback.sqlite'));
		const created = repository.createCase({
			title: '新人入住宿舍',
			goal: '确认 8 月 2 日到达后是否可以实际入住',
			confusion: '缺少房间和钥匙信息'
		});
		for (const evidence of dormDemoEvidence) {
			repository.appendEvidence(created.id, {
				kind: evidence.kind,
				content: evidence.content,
				sourceLabel: evidence.sourceLabel,
				occurredAt: evidence.occurredAt
			});
		}

		const waiting = buildDormDemoFallback(repository.getCase(created.id)!);
		expect(waiting?.stage).toBe('waiting');

		const reply = repository.appendEvidence(created.id, {
			kind: 'message',
			content: '物业刚回复：房间已经分配，钥匙在前台领取。',
			sourceLabel: '我的补充',
			occurredAt: null
		});
		const actionable = buildDormDemoFallback(repository.getCase(created.id)!);

		expect(actionable).toMatchObject({
			stage: 'actionable',
			currentBlocker: '房间与钥匙位置已经补全，需要确认到达时间和前台领取细节',
			keyCompleter: { participantId: 'participant-property' },
			nextAction: { contactParticipantId: 'participant-property' }
		});
		expect(actionable?.claims.find((claim) => claim.id === 'claim-room')).toMatchObject({
			kind: 'statement',
			evidenceIds: [reply.id]
		});
		expect(actionable?.claims.find((claim) => claim.id === 'claim-key')).toMatchObject({
			kind: 'statement',
			evidenceIds: [reply.id]
		});
		repository.close();
	});

	it('does not treat a negated or unattributed follow-up as property confirmation', () => {
		const directory = mkdtempSync(join(tmpdir(), 'background-fallback-'));
		directories.push(directory);
		const repository = createCaseRepository(join(directory, 'fallback.sqlite'));
		const created = repository.createCase({
			title: '新人入住宿舍',
			goal: '确认 8 月 2 日到达后是否可以实际入住',
			confusion: '缺少房间和钥匙信息'
		});
		for (const evidence of dormDemoEvidence)
			repository.appendEvidence(created.id, {
				kind: evidence.kind,
				content: evidence.content,
				sourceLabel: evidence.sourceLabel,
				occurredAt: evidence.occurredAt
			});
		repository.appendEvidence(created.id, {
			kind: 'message',
			content: '尚未确认房间已经分配，钥匙由谁领取也不知道。',
			sourceLabel: '我的补充',
			occurredAt: null
		});
		expect(buildDormDemoFallback(repository.getCase(created.id)!)?.stage).toBe('waiting');
		repository.close();
	});
});
