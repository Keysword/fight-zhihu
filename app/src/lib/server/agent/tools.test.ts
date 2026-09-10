import { describe, expect, it } from 'vitest';
import { dormDemoBoard, dormDemoEvidence } from '$lib/domain/demo-case';
import type { BackgroundBoard, CaseRecord, ExternalClue } from '$lib/domain/types';
import { AgentSafetyError, validateBoardForCase } from './tools';

function record(board: BackgroundBoard | null = null): CaseRecord {
	return {
		id: 'case-1',
		title: '新人入住宿舍',
		goal: '确认 8 月 2 日到达后是否可以实际入住',
		confusion: '缺少信息',
		stage: board?.stage ?? 'collecting',
		revision: board ? 1 : 0,
		createdAt: '2026-09-05T00:00:00.000Z',
		updatedAt: '2026-09-05T00:00:00.000Z',
		board,
		evidence: structuredClone(dormDemoEvidence)
	};
}
function board(): BackgroundBoard {
	return { ...structuredClone(dormDemoBoard), caseId: 'case-1', externalClues: [] };
}
const clue: ExternalClue = {
	id: 'clue-1',
	title: '原始标题',
	excerpt: '原始摘要',
	url: 'https://www.zhihu.com/question/1',
	author: '作者',
	editedAt: null,
	authorityLevel: null,
	source: 'zhihu',
	relevance: '相似场景',
	warning: '外部经验，仅供核实'
};

describe('board safety validation', () => {
	it('requires external clues to be byte-for-byte tool results', () => {
		const proposed = board();
		proposed.externalClues = [{ ...clue, url: 'https://attacker.example/fake' }];
		expect(() => validateBoardForCase(proposed, record(), [clue])).toThrow(AgentSafetyError);
	});
	it('allows facts only when an official notice directly supports the claim', () => {
		const proposed = board();
		proposed.claims[0] = {
			id: 'claim-fact',
			kind: 'fact',
			text: '房间已经分配',
			evidenceIds: ['evidence-contact']
		};
		expect(() => validateBoardForCase(proposed, record(), [])).toThrow(/正式通知/);
		const caseRecord = record();
		caseRecord.evidence.push({
			id: 'official-notice',
			kind: 'notice',
			content: '正式住宿通知：房间已经分配，请到前台领取钥匙。',
			sourceLabel: '住宿管理通知',
			occurredAt: null,
			confirmation: 'official'
		});
		proposed.claims[0].evidenceIds = ['official-notice'];
		expect(() => validateBoardForCase(proposed, caseRecord, [])).not.toThrow();
		proposed.claims[0].text = '工资已经到账';
		expect(() => validateBoardForCase(proposed, caseRecord, [])).toThrow(/不能支持/);
	});
	it('accepts a fact backed by evidence the user marked as confirmed', () => {
		const proposed = board();
		const caseRecord = record();
		caseRecord.evidence.push({
			id: 'user-confirmed',
			kind: 'message',
			content: '物业回复：房间已经分配，钥匙在前台领取。',
			sourceLabel: '物业',
			occurredAt: null,
			confirmation: 'official'
		});
		proposed.claims[0] = {
			id: 'claim-fact',
			kind: 'fact',
			text: '房间已经分配',
			evidenceIds: ['user-confirmed']
		};
		expect(() => validateBoardForCase(proposed, caseRecord, [])).not.toThrow();

		proposed.claims[0] = {
			id: 'claim-fact',
			kind: 'fact',
			text: '房间已经分配',
			evidenceIds: ['evidence-contact']
		};
		expect(() => validateBoardForCase(proposed, caseRecord, [])).toThrow(/用户标记为已确认/);
	});
	it('rejects motive accusations in participant and action fields', () => {
		const proposed = board();
		proposed.participants[0].providedInfo = ['对方针对新人，故意不说'];
		expect(() => validateBoardForCase(proposed, record(), [])).toThrow(/动机归因/);
		proposed.participants[0].providedInfo = ['可以协调接引'];
		proposed.nextAction!.message = '请解释你为什么推卸责任。';
		expect(() => validateBoardForCase(proposed, record(), [])).toThrow(/动机归因/);
	});
});
