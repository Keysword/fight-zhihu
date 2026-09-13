import { describe, expect, it } from 'vitest';

import type { SourceRef } from '$lib/domain/guidance';
import { salvageGuidance, type AllowedSourceIds } from './guidance-salvage';

function allowed(overrides: Partial<Record<keyof AllowedSourceIds, string[]>> = {}): AllowedSourceIds {
	return {
		evidence: new Set(overrides.evidence ?? ['evidence-1']),
		input: new Set(overrides.input ?? ['input-1']),
		external: new Set(overrides.external ?? ['external-1'])
	};
}

function check(sources: SourceRef[]) {
	return {
		observation: '材料只提到了申请。',
		possibleMisreading: '这可能被理解为已经安排完成。',
		whyItMatters: '会影响明天的住宿准备。',
		howToCheck: '核对房间号和领钥匙时间。',
		sources
	};
}

function contactStep(sources: SourceRef[], kind = 'contact') {
	return {
		kind,
		instruction: '请已有对接人提供确认入口。',
		why: '先确认实际安排。',
		contact: { label: '住宿经办入口', basis: 'case_material', sources },
		message: null,
		branches: []
	};
}

function fullDraft(overrides: Record<string, unknown> = {}) {
	return {
		understanding: {
			summary: '目前只知道申请已被转达，实际安排仍需确认。',
			openPoint: '房间和时间尚不清楚。',
			sources: [{ kind: 'evidence', id: 'evidence-1' }]
		},
		communicationChecks: [check([{ kind: 'evidence', id: 'evidence-1' }])],
		nextStep: contactStep([{ kind: 'evidence', id: 'evidence-1' }]),
		question: null,
		changeSummary: null,
		...overrides
	};
}

describe('guidance salvage', () => {
	it('passes a fully valid draft straight through', () => {
		const outcome = salvageGuidance(fullDraft(), allowed());

		expect(outcome.completeness).toBe('full');
		expect(outcome.dropped).toEqual([]);
		expect(outcome.draft?.communicationChecks).toHaveLength(1);
		expect(outcome.draft?.nextStep).not.toBeNull();
	});

	it('drops only the offending check when its reference is illegal', () => {
		const outcome = salvageGuidance(
			fullDraft({
				communicationChecks: [
					check([{ kind: 'evidence', id: 'ghost' }]),
					check([{ kind: 'input', id: 'input-1' }])
				]
			}),
			allowed()
		);

		expect(outcome.completeness).toBe('partial');
		expect(outcome.draft?.communicationChecks).toHaveLength(1);
		expect(outcome.draft?.communicationChecks[0]?.sources).toEqual([
			{ kind: 'input', id: 'input-1' }
		]);
		expect(outcome.draft?.understanding.summary).toContain('申请已被转达');
		expect(outcome.dropped).toEqual([
			expect.objectContaining({ field: 'communicationChecks', reason: 'reference' })
		]);
	});

	it('strips unknown fields instead of vetoing the reply', () => {
		const outcome = salvageGuidance(
			fullDraft({ credibilityScore: 0.4, caseId: 'case-1' }),
			allowed()
		);

		expect(outcome.draft).not.toBeNull();
		expect(outcome.draft).not.toHaveProperty('credibilityScore');
		expect(outcome.completeness).toBe('partial');
		expect(outcome.dropped).toEqual([
			expect.objectContaining({ field: 'unknownFields', reason: 'schema' })
		]);
	});

	it('keeps understanding and marks minimal when every optional block is unusable', () => {
		const outcome = salvageGuidance(
			{
				understanding: {
					summary: '只整理出了目前的理解。',
					openPoint: null,
					sources: [{ kind: 'evidence', id: 'evidence-1' }]
				},
				communicationChecks: [check([])],
				nextStep: { kind: 'nonsense', instruction: '' },
				question: '',
				changeSummary: null
			},
			allowed()
		);

		expect(outcome.completeness).toBe('minimal');
		expect(outcome.draft?.understanding.summary).toBe('只整理出了目前的理解。');
		expect(outcome.draft?.communicationChecks).toEqual([]);
		expect(outcome.draft?.nextStep).toBeNull();
		expect(outcome.dropped.map((item) => item.field)).toContain('nextStep');
	});

	it('treats a missing understanding summary as a real failure', () => {
		const outcome = salvageGuidance(
			{ understanding: { openPoint: '不清楚', sources: [] }, communicationChecks: [] },
			allowed()
		);

		expect(outcome.draft).toBeNull();
		expect(outcome.dropped).toEqual([
			expect.objectContaining({ field: 'understanding.summary', reason: 'schema' })
		]);
	});

	it('removes illegal understanding references without dropping the summary', () => {
		const outcome = salvageGuidance(
			fullDraft({
				understanding: {
					summary: '现有材料只能支持部分判断。',
					openPoint: null,
					sources: [
						{ kind: 'evidence', id: 'evidence-1' },
						{ kind: 'external', id: 'stale-clue' }
					]
				}
			}),
			allowed()
		);

		expect(outcome.draft?.understanding.sources).toEqual([{ kind: 'evidence', id: 'evidence-1' }]);
		expect(outcome.completeness).toBe('partial');
		expect(outcome.dropped).toEqual([
			expect.objectContaining({ field: 'understanding.sources', reason: 'reference' })
		]);
	});

	it('drops a contact next step that loses the local source it requires', () => {
		const outcome = salvageGuidance(
			fullDraft({ nextStep: contactStep([{ kind: 'evidence', id: 'ghost' }]) }),
			allowed()
		);

		expect(outcome.draft?.nextStep).toBeNull();
		expect(outcome.draft?.communicationChecks).toHaveLength(1);
		expect(outcome.dropped).toEqual([
			expect.objectContaining({ field: 'nextStep', reason: 'reference' })
		]);
	});

	it('demotes contact to null for a non-contact action rather than dropping the step', () => {
		const outcome = salvageGuidance(
			fullDraft({ nextStep: contactStep([{ kind: 'evidence', id: 'ghost' }], 'inspect') }),
			allowed()
		);

		expect(outcome.draft?.nextStep?.kind).toBe('inspect');
		expect(outcome.draft?.nextStep?.contact).toBeNull();
		expect(outcome.completeness).toBe('partial');
	});

	it('never emits references the caller did not allow', () => {
		const outcome = salvageGuidance(
			fullDraft({
				understanding: {
					summary: '摘要',
					openPoint: null,
					sources: [{ kind: 'external', id: 'not-this-run' }]
				},
				communicationChecks: [
					check([
						{ kind: 'evidence', id: 'evidence-1' },
						{ kind: 'external', id: 'not-this-run' }
					])
				]
			}),
			allowed()
		);

		const emitted = JSON.stringify(outcome.draft);
		expect(emitted).not.toContain('not-this-run');
		expect(outcome.draft?.communicationChecks[0]?.sources).toEqual([
			{ kind: 'evidence', id: 'evidence-1' }
		]);
	});
});
