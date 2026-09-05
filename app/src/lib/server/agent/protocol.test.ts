import { describe, expect, it } from 'vitest';

import { parseAgentAction, AgentProtocolError } from './protocol';

describe('agent protocol', () => {
	it('accepts direct JSON actions', () => {
		expect(parseAgentAction('{"type":"search_zhihu","query":"新人 宿舍","count":3}')).toEqual({
			type: 'search_zhihu',
			query: '新人 宿舍',
			count: 3
		});
	});

	it('accepts exactly one fenced JSON object', () => {
		expect(parseAgentAction('```json\n{"type":"finish","summary":"已形成行动建议"}\n```')).toEqual({
			type: 'finish',
			summary: '已形成行动建议'
		});
	});

	it('rejects prose, unsupported tools, and malformed payloads', () => {
		expect(() => parseAgentAction('我建议先去问人力。')).toThrow(AgentProtocolError);
		expect(() => parseAgentAction('{"type":"browse_web","query":"test"}')).toThrow(
			/不符合协议/
		);
		expect(() => parseAgentAction('{"type":"search_zhihu","query":"","count":50}')).toThrow(
			AgentProtocolError
		);
	});

	it('rejects unsupported facts and unexplained key completers', () => {
		const invalidBoard = {
			caseId: 'case-1',
			title: '宿舍',
			goal: '入住',
			stage: 'actionable',
			currentBlocker: '房间未知',
			claims: [{ id: 'fact-1', kind: 'fact', text: '已经分房', evidenceIds: [] }],
			participants: [],
			keyCompleter: {
				participantId: 'hr',
				scope: '住宿',
				rationale: '',
				confidence: 'high',
				uncertainty: '',
				evidenceIds: []
			},
			nextAction: null,
			externalClues: [],
			updatedAt: new Date().toISOString()
		};
		expect(() =>
			parseAgentAction(JSON.stringify({ type: 'propose_board_patch', board: invalidBoard, summary: '更新' }))
		).toThrow(AgentProtocolError);
	});
});
