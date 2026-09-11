import { describe, expect, it } from 'vitest';
import { caseInputSchema, guidanceDraftSchema, sourceRefSchema } from './guidance';

const validRequestId = '4a46c4bc-7666-4f48-8f20-dcc46b1d7260';

function summaryOnlyDraft() {
	return {
		understanding: {
			summary: '宿舍调整还在等待明确安排。',
			openPoint: null
		},
		nextStep: null,
		question: null,
		changeSummary: null
	};
}

function communicationCheck() {
	return {
		observation: '通知只说了可以申请。',
		possibleMisreading: '可能把“可以申请”理解成“已经批准”。',
		whyItMatters: '这会影响是否现在搬运。',
		howToCheck: '确认是否已有房间号和生效时间。',
		sources: [{ kind: 'evidence' as const, id: 'evidence-1' }]
	};
}

function nextStep(kind: 'contact' | 'inspect' | 'wait' | 'answer') {
	return {
		kind,
		instruction: '联系负责宿舍安排的人。',
		why: '需要确认安排是否已生效。',
		contact: null,
		message: null,
		branches: []
	};
}

describe('guidanceDraftSchema', () => {
	it('接受只有 summary 的有效梳理，且 nextStep 和 question 可同时为 null', () => {
		const result = guidanceDraftSchema.parse(summaryOnlyDraft());

		expect(result.understanding.summary).toBe('宿舍调整还在等待明确安排。');
		expect(result.nextStep).toBeNull();
		expect(result.question).toBeNull();
	});

	it('接受零个沟通疑点', () => {
		expect(
			guidanceDraftSchema.safeParse({
				...summaryOnlyDraft(),
				communicationChecks: []
			}).success
		).toBe(true);
	});

	it('接受字段完整且有本地来源的沟通疑点', () => {
		const result = guidanceDraftSchema.parse({
			...summaryOnlyDraft(),
			communicationChecks: [communicationCheck()]
		});

		expect(result.communicationChecks).toHaveLength(1);
		expect(result.communicationChecks[0].sources[0]).toEqual({
			kind: 'evidence',
			id: 'evidence-1'
		});
	});

	it('接受只有追问而没有 nextStep', () => {
		const result = guidanceDraftSchema.parse({
			...summaryOnlyDraft(),
			nextStep: null,
			question: '你收到的通知里有具体房间号吗？'
		});

		expect(result.nextStep).toBeNull();
		expect(result.question).toContain('房间号');
	});

	it('接受没有依据的一般角色建议', () => {
		const result = guidanceDraftSchema.parse({
			...summaryOnlyDraft(),
			nextStep: {
				...nextStep('contact'),
				contact: {
					label: '可以询问宿管或辅导员',
					basis: 'suggested_role'
				}
			}
		});

		expect(result.nextStep?.contact?.sources).toEqual([]);
	});

	it.each(['fact', 'confirmation'])('拒绝沟通疑点中的未知字段 %s', (unknownField) => {
		expect(
			guidanceDraftSchema.safeParse({
				...summaryOnlyDraft(),
				communicationChecks: [
					{
						...communicationCheck(),
						[unknownField]: '模型额外输出'
					}
				]
			}).success
		).toBe(false);
	});

	it('拒绝超过两个沟通疑点', () => {
		expect(
			guidanceDraftSchema.safeParse({
				...summaryOnlyDraft(),
				communicationChecks: [communicationCheck(), communicationCheck(), communicationCheck()]
			}).success
		).toBe(false);
	});

	it('拒绝缺少 summary 的梳理', () => {
		expect(
			guidanceDraftSchema.safeParse({
				...summaryOnlyDraft(),
				understanding: { openPoint: null }
			}).success
		).toBe(false);
	});

	it('拒绝没有联系人的 contact 动作', () => {
		expect(
			guidanceDraftSchema.safeParse({
				...summaryOnlyDraft(),
				nextStep: nextStep('contact')
			}).success
		).toBe(false);
	});

	it('拒绝没有 question 的 answer 动作', () => {
		expect(
			guidanceDraftSchema.safeParse({
				...summaryOnlyDraft(),
				nextStep: nextStep('answer'),
				question: null
			}).success
		).toBe(false);
	});

	it('拒绝只有外部来源的沟通疑点', () => {
		expect(
			guidanceDraftSchema.safeParse({
				...summaryOnlyDraft(),
				communicationChecks: [
					{
						...communicationCheck(),
						sources: [{ kind: 'external', id: 'clue-1' }]
					}
				]
			}).success
		).toBe(false);
	});

	it('拒绝没有本地来源的 case_material 联系人', () => {
		expect(
			guidanceDraftSchema.safeParse({
				...summaryOnlyDraft(),
				nextStep: {
					...nextStep('contact'),
					contact: {
						label: '宿舍负责人',
						basis: 'case_material',
						sources: [{ kind: 'external', id: 'clue-1' }]
					}
				}
			}).success
		).toBe(false);
	});

	it('为所有可省略数组补上默认空数组', () => {
		const result = guidanceDraftSchema.parse({
			understanding: {
				summary: '  当前只能确认申请已提交。  ',
				openPoint: null
			},
			nextStep: {
				...nextStep('contact'),
				branches: undefined,
				contact: {
					label: '可以询问宿管',
					basis: 'suggested_role'
				}
			},
			question: null,
			changeSummary: null
		});

		expect(result.understanding.summary).toBe('当前只能确认申请已提交。');
		expect(result.understanding.sources).toEqual([]);
		expect(result.communicationChecks).toEqual([]);
		expect(result.nextStep?.branches).toEqual([]);
		expect(result.nextStep?.contact?.sources).toEqual([]);
	});
});

describe('caseInputSchema', () => {
	it('校验 UUID requestId，修剪 content 并默认 guidanceId 为 null', () => {
		const result = caseInputSchema.parse({
			kind: 'context',
			content: '  新收到一条宿舍通知。  ',
			requestId: validRequestId
		});

		expect(result.content).toBe('新收到一条宿舍通知。');
		expect(result.guidanceId).toBeNull();
		expect(
			caseInputSchema.safeParse({
				kind: 'context',
				content: '新收到一条宿舍通知。',
				requestId: 'not-a-uuid'
			}).success
		).toBe(false);
	});
});

describe('sourceRefSchema', () => {
	it('拒绝空 id 和未知字段', () => {
		expect(sourceRefSchema.safeParse({ kind: 'input', id: '' }).success).toBe(false);
		expect(
			sourceRefSchema.safeParse({ kind: 'input', id: 'input-1', label: '额外字段' }).success
		).toBe(false);
	});
});
