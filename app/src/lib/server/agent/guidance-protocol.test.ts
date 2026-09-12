import { describe, expect, it } from 'vitest';

import { AgentProtocolError } from './protocol';
import { parseGuidanceAction } from './guidance-protocol';

const guidance = {
	understanding: {
		summary: '申请得到回复，并不等于房间和入住时间已经安排。',
		openPoint: '实际入住安排仍不清楚。',
		sources: [{ kind: 'evidence', id: 'evidence-1' }]
	},
	communicationChecks: [],
	nextStep: null,
	question: '你是否收到过包含房间号或领钥匙时间的通知？',
	changeSummary: null
};

describe('guidance protocol', () => {
	it('accepts direct, fenced, leading, and trailing JSON without semantic text matching', () => {
		const action = { type: 'provide_guidance', guidance };
		const json = JSON.stringify(action);

		expect(parseGuidanceAction(json)).toEqual(action);
		expect(parseGuidanceAction(`\`\`\`json\n${json}\n\`\`\``)).toEqual(action);
		expect(parseGuidanceAction(`这是当前整理。\n${json}`)).toEqual(action);
		expect(parseGuidanceAction(`${json}\n以上是说明。`)).toEqual(action);
	});

	it('does not let braces inside guidance strings confuse object boundaries', () => {
		const action = {
			type: 'provide_guidance',
			guidance: {
				...guidance,
				understanding: {
					...guidance.understanding,
					summary: '通知写的是“房间号 {待确认}”，仍需核实。'
				}
			}
		};
		expect(parseGuidanceAction(`${JSON.stringify(action)}后续文字`)).toEqual(action);
	});

	it('accepts only the two searches and provide_guidance', () => {
		expect(parseGuidanceAction('{"type":"search_zhihu","query":"新人 入住","count":3}')).toEqual({
			type: 'search_zhihu',
			query: '新人 入住',
			count: 3
		});
		expect(
			parseGuidanceAction('{"type":"search_global","query":"入职住宿安排","count":5}')
		).toEqual({
			type: 'search_global',
			query: '入职住宿安排',
			count: 5
		});

		for (const type of ['ask_user', 'finish', 'propose_board_patch']) {
			expect(() =>
				parseGuidanceAction(JSON.stringify({ type, question: '问题', summary: '完成' }))
			).toThrow(AgentProtocolError);
		}
	});

	it('rejects caseId and every extra field at action and guidance levels', () => {
		expect(() =>
			parseGuidanceAction(JSON.stringify({ type: 'provide_guidance', guidance, caseId: 'case-1' }))
		).toThrow(/caseId/);
		expect(() =>
			parseGuidanceAction(
				JSON.stringify({ type: 'provide_guidance', guidance: { ...guidance, fact: '已经安排' } })
			)
		).toThrow(/guidance/);
		expect(() =>
			parseGuidanceAction(
				JSON.stringify({ type: 'search_global', query: '住宿', count: 1, token: 'secret' })
			)
		).toThrow(/token/);
	});

	it('reports the field path for structurally invalid guidance', () => {
		const invalid = {
			type: 'provide_guidance',
			guidance: {
				...guidance,
				nextStep: {
					kind: 'contact',
					instruction: '联系经办入口',
					why: '确认实际安排',
					contact: null,
					message: null,
					branches: []
				}
			}
		};

		expect(() => parseGuidanceAction(JSON.stringify(invalid))).toThrow(
			/guidance\.nextStep\.contact/
		);
	});

	it('enforces local-source rules while leaving source ownership to runtime', () => {
		const externallySupportedCheck = {
			...guidance,
			communicationChecks: [
				{
					observation: '对接人只说会申请。',
					possibleMisreading: '可能被理解为已经安排。',
					whyItMatters: '会影响是否准备临时住宿。',
					howToCheck: '查看是否有房间号和领钥匙时间。',
					sources: [{ kind: 'external', id: 'missing-external-id' }]
				}
			]
		};
		expect(() =>
			parseGuidanceAction(
				JSON.stringify({ type: 'provide_guidance', guidance: externallySupportedCheck })
			)
		).toThrow(/guidance\.communicationChecks\.0\.sources/);

		const unknownIds = {
			...guidance,
			understanding: {
				...guidance.understanding,
				sources: [{ kind: 'evidence', id: 'unknown-but-well-formed-id' }]
			}
		};
		expect(
			parseGuidanceAction(JSON.stringify({ type: 'provide_guidance', guidance: unknownIds }))
		).toEqual({ type: 'provide_guidance', guidance: unknownIds });
	});
});
