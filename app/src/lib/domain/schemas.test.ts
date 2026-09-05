import { describe, expect, it } from 'vitest';
import { backgroundBoardSchema, claimSchema, keyCompleterSchema } from './schemas';

describe('claimSchema', () => {
	it('requires evidence for confirmed facts', () => {
		expect(() =>
			claimSchema.parse({
				id: 'claim-1',
				kind: 'fact',
				text: '房间已经分配',
				evidenceIds: []
			})
		).toThrow(/证据/);
	});

	it('requires a rationale for an inference', () => {
		expect(() =>
			claimSchema.parse({
				id: 'claim-2',
				kind: 'inference',
				text: '人力能够协调物业',
				evidenceIds: ['evidence-1'],
				rationale: ''
			})
		).toThrow(/依据/);
	});
});

describe('keyCompleterSchema', () => {
	it('keeps rationale, confidence and uncertainty together', () => {
		const result = keyCompleterSchema.parse({
			participantId: 'participant-hr',
			scope: '确认房间和钥匙状态',
			rationale: '负责正式通知并能联系物业',
			confidence: 'high',
			uncertainty: '不能证明其已经看过房间结果',
			evidenceIds: ['evidence-hr']
		});

		expect(result.confidence).toBe('high');
		expect(result.uncertainty).toContain('不能证明');
	});
});

describe('backgroundBoardSchema', () => {
	it('rejects unknown keys at the model boundary', () => {
		expect(() =>
			backgroundBoardSchema.parse({
				caseId: 'case-1',
				title: '测试事项',
				goal: '完成测试',
				stage: 'collecting',
				currentBlocker: '信息不足',
				claims: [],
				participants: [],
				keyCompleter: null,
				nextAction: null,
				externalClues: [],
				updatedAt: '2026-09-05T00:00:00.000Z',
				invented: true
			})
		).toThrow();
	});
});
