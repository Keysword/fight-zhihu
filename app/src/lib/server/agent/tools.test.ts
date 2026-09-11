import { describe, expect, it } from 'vitest';
import { dormDemoBoard, dormDemoEvidence } from '$lib/domain/demo-case';
import type { BackgroundBoard, CaseRecord, ExternalClue } from '$lib/domain/types';
import {
	AgentSafetyError,
	downgradeUnsupportedFacts,
	evaluateFactSupport,
	validateBoardForCase
} from './tools';

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

describe('fact source-span validation (handoff task 1)', () => {
	/**
	 * 结论必须是证据原文中一段独立的断言，不能从否定、条件、疑问或
	 * 未确认转述的范围里截取肯定片段。
	 */
	const cases: Array<{ evidence: string; claim: string; allowed: boolean; note: string }> = [
		{ evidence: '不能领取钥匙', claim: '领取钥匙', allowed: false, note: '从否定中截取' },
		{ evidence: '并非已经分配房间', claim: '已经分配房间', allowed: false, note: '从否定中截取' },
		{
			evidence: '如果审批通过，就可以领取钥匙',
			claim: '可以领取钥匙',
			allowed: false,
			note: '从条件句中截取'
		},
		{
			evidence: '有人问“房间已经分配”是否属实，目前尚未确认',
			claim: '房间已经分配',
			allowed: false,
			note: '从未确认转述中截取'
		},
		{
			evidence: '物业回复：房间已经分配，钥匙在前台领取。',
			claim: '房间已经分配',
			allowed: true,
			note: '独立肯定断言'
		},
		{
			evidence: '物业回复：房间尚未分配。',
			claim: '房间尚未分配',
			allowed: true,
			note: '独立否定断言'
		},
		// 线上实测的高频误拒：逐字引用整条证据会跨多个分句，仍然应当被接受。
		{
			evidence: '部门对接人：应该可以提前入住，我先申请。之后会有同事联系你，在门口接你。',
			claim: '部门对接人：应该可以提前入住，我先申请。之后会有同事联系你，在门口接你。',
			allowed: true,
			note: '逐字引用整条证据（跨分句）'
		},
		// 模型最常见的写法：出处前缀 + 逐字引用。
		{
			evidence: '部门对接人：应该可以提前入住，我先申请。',
			claim: '部门对接人表示：应该可以提前入住，我先申请',
			allowed: true,
			note: '归属前缀 + 逐字引用'
		},
		{
			evidence: '财务：你的报销单格式不对，退回重填。',
			claim: '财务告知：你的报销单格式不对，退回重填',
			allowed: true,
			note: '归属前缀 + 逐字引用'
		},
		// 但归属前缀不得把证据里的否定洗掉。
		{
			evidence: '人力：不能提前入住。',
			claim: '人力表示：可以提前入住',
			allowed: false,
			note: '归属前缀不得绕过否定'
		}
	];

	for (const { evidence, claim, allowed, note } of cases) {
		it(`${allowed ? 'allows' : 'rejects'} “${claim}” (${note})`, () => {
			const caseRecord = record();
			caseRecord.evidence.push({
				id: 'confirmed-source',
				kind: 'message',
				content: evidence,
				sourceLabel: '物业',
				occurredAt: null,
				confirmation: 'official'
			});
			const proposed = board();
			proposed.claims[0] = {
				id: 'claim-fact',
				kind: 'fact',
				text: claim,
				evidenceIds: ['confirmed-source']
			};
			if (allowed) {
				expect(() => validateBoardForCase(proposed, caseRecord, [])).not.toThrow();
			} else {
				expect(() => validateBoardForCase(proposed, caseRecord, [])).toThrow(AgentSafetyError);
			}
		});
	}
});

describe('board safety validation', () => {
	it('requires external clues to be byte-for-byte tool results', () => {
		const proposed = board();
		proposed.externalClues = [{ ...clue, url: 'https://attacker.example/fake' }];
		expect(() => validateBoardForCase(proposed, record(), [clue])).toThrow(AgentSafetyError);
	});
	it('allows facts only when an official notice directly supports the claim', () => {
		const proposed = board();
		// 内容确实出自这条证据，但该证据只是聊天记录，来源未经确认。
		proposed.claims[0] = {
			id: 'claim-fact',
			kind: 'fact',
			text: '应该可以提前入住',
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
		proposed.claims[0].text = '房间已经分配';
		expect(() => validateBoardForCase(proposed, caseRecord, [])).not.toThrow();
		proposed.claims[0].text = '工资已经到账';
		expect(() => validateBoardForCase(proposed, caseRecord, [])).toThrow(/引用证据没有支持/);
	});
	it('does not let a fact smuggle in a contradiction the evidence never stated', () => {
		const caseRecord = record();
		caseRecord.evidence.push({
			id: 'official-notice',
			kind: 'notice',
			content: '正式住宿通知：房间已经分配，请到前台领取钥匙。',
			sourceLabel: '住宿管理通知',
			occurredAt: null,
			confirmation: 'official'
		});
		const proposed = board();
		for (const text of [
			'房间尚未分配',
			'房间已经分配但钥匙不能领取',
			'房间已经分配，钥匙无法在前台领取',
			'房间已经分配，无需到前台领取钥匙'
		]) {
			proposed.claims[0] = {
				id: 'claim-fact',
				kind: 'fact',
				text,
				evidenceIds: ['official-notice']
			};
			expect(() => validateBoardForCase(proposed, caseRecord, [])).toThrow(AgentSafetyError);
		}
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
			text: '应该可以提前入住',
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

describe('fact downgrade fallback', () => {
	// 内容有依据、只是来源未确认时，保留信息但降级确定性。
	it('rewrites a source-unconfirmed fact as a statement instead of failing the run', () => {
		const caseRecord = record();
		const proposed = board();
		proposed.claims[0] = {
			id: 'claim-fact',
			kind: 'fact',
			text: '应该可以提前入住',
			evidenceIds: ['evidence-contact']
		};
		expect(() => validateBoardForCase(proposed, caseRecord, [])).toThrow(AgentSafetyError);

		const { board: downgraded, downgrades } = downgradeUnsupportedFacts(proposed, caseRecord);

		expect(downgrades).toHaveLength(1);
		expect(downgrades[0].id).toBe('claim-fact');
		expect(downgrades[0].reason).toContain('必须引用正式通知');
		expect(downgraded.claims[0].kind).toBe('statement');
		// 信息本身必须保留，只降级它的确定性。
		expect(downgraded.claims[0].text).toBe('应该可以提前入住');
		expect(downgraded.claims[0].rationale).toContain('暂按他人说法记录');
		expect(() => validateBoardForCase(downgraded, caseRecord, [])).not.toThrow();
	});

	// 原文从未说过的内容，绝不允许借降级保留为“他人说法”。
	it('never downgrades content the evidence does not support', () => {
		const caseRecord = record();
		const proposed = board();
		proposed.claims[0] = {
			id: 'claim-fact',
			kind: 'fact',
			text: '房间已经分配',
			evidenceIds: ['evidence-contact']
		};
		const { downgrades } = downgradeUnsupportedFacts(proposed, caseRecord);
		expect(downgrades).toHaveLength(0);
		expect(() => validateBoardForCase(proposed, caseRecord, [])).toThrow(AgentSafetyError);
	});

	// 删掉否定后，即使来源已确认也不能降级放行。
	it('never downgrades a claim that inverts a confirmed negation', () => {
		const caseRecord = record();
		caseRecord.evidence.push({
			id: 'confirmed-negative',
			kind: 'message',
			content: '物业：不能领取钥匙。',
			sourceLabel: '物业',
			occurredAt: null,
			confirmation: 'official'
		});
		const proposed = board();
		proposed.claims[0] = {
			id: 'claim-fact',
			kind: 'fact',
			text: '领取钥匙',
			evidenceIds: ['confirmed-negative']
		};
		const { downgrades } = downgradeUnsupportedFacts(proposed, caseRecord);
		expect(downgrades).toHaveLength(0);
		expect(() => validateBoardForCase(proposed, caseRecord, [])).toThrow(AgentSafetyError);
	});

	it('leaves facts that do have confirmed evidence untouched', () => {
		const caseRecord = record();
		caseRecord.evidence.push({
			id: 'user-confirmed',
			kind: 'message',
			content: '物业回复：房间已经分配，钥匙在前台领取。',
			sourceLabel: '物业',
			occurredAt: null,
			confirmation: 'official'
		});
		const proposed = board();
		proposed.claims[0] = {
			id: 'claim-fact',
			kind: 'fact',
			text: '房间已经分配',
			evidenceIds: ['user-confirmed']
		};
		const { board: downgraded, downgrades } = downgradeUnsupportedFacts(proposed, caseRecord);
		expect(downgrades).toHaveLength(0);
		expect(downgraded.claims[0].kind).toBe('fact');
	});

	// 失败说明必须对应真实原因：来源已确认但内容不成立时，不能说“缺少正式确认”。
	it('reports the content problem, not a missing confirmation, when the source is confirmed', () => {
		const caseRecord = record();
		caseRecord.evidence.push({
			id: 'confirmed-source',
			kind: 'message',
			content: '物业：请联系前台。',
			sourceLabel: '物业',
			occurredAt: null,
			confirmation: 'official'
		});
		const proposed = board();
		proposed.claims[0] = {
			id: 'claim-fact',
			kind: 'fact',
			text: '房间已经分配',
			evidenceIds: ['confirmed-source']
		};
		const issue = evaluateFactSupport(proposed.claims[0], caseRecord);
		expect(issue?.kind).toBe('content_unsupported');
		expect(issue?.message).not.toContain('必须引用正式通知');
		expect(issue?.message).toContain('没有支持');
	});
});
