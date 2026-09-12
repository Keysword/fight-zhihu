import { describe, expect, it } from 'vitest';

import { parseAgentAction, AgentProtocolError, parseJsonObject } from './protocol';

describe('agent protocol', () => {
	it('exports the balanced JSON parser used by model action protocols', () => {
		const object = JSON.stringify({ summary: '包含 {花括号} 和 "引号"' });
		expect(parseJsonObject(`开场 ${object} 结尾`)).toEqual({
			summary: '包含 {花括号} 和 "引号"'
		});
	});

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

	// 真实模型经常在动作 JSON 后面追一句解释。这类输出是合法的，
	// 不应该被拒绝、更不应该浪费一次修复回合。
	it('accepts an action JSON followed by trailing prose', () => {
		expect(
			parseAgentAction(
				'{"type":"finish","summary":"已形成行动建议"}\n\n以上是我的判断，理由是人力已经掌握名单状态。'
			)
		).toEqual({ type: 'finish', summary: '已形成行动建议' });
	});

	it('accepts an action JSON preceded by a lead-in sentence', () => {
		expect(
			parseAgentAction(
				'我先整理了当前缺口。\n{"type":"ask_user","question":"请问房间号确认了吗？"}'
			)
		).toEqual({ type: 'ask_user', question: '请问房间号确认了吗？' });
	});

	it('does not let braces inside strings confuse object boundaries', () => {
		expect(
			parseAgentAction(
				'{"type":"finish","summary":"值班表里写了 {待确认}，需要再问一次"}有疑问随时问我。'
			)
		).toEqual({ type: 'finish', summary: '值班表里写了 {待确认}，需要再问一次' });
	});

	it('rejects prose, unsupported tools, and malformed payloads', () => {
		expect(() => parseAgentAction('我建议先去问人力。')).toThrow(AgentProtocolError);
		expect(() => parseAgentAction('{"type":"browse_web","query":"test"}')).toThrow(/不符合协议/);
		expect(() => parseAgentAction('{"type":"search_zhihu","query":"","count":50}')).toThrow(
			AgentProtocolError
		);
		expect(() => parseAgentAction('{"type":"finish","summary":"没有闭合"')).toThrow(/没有闭合/);
	});

	// “不符合协议”本身无法定位问题，失败时必须带出具体字段。
	it('names the offending field when an action fails the schema', () => {
		let message = '';
		try {
			parseAgentAction('{"type":"search_zhihu","query":"新人入住","count":50}');
		} catch (error) {
			message = error instanceof Error ? error.message : '';
		}
		expect(message).toContain('不符合协议');
		expect(message).toContain('count');
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
			parseAgentAction(
				JSON.stringify({ type: 'propose_board_patch', board: invalidBoard, summary: '更新' })
			)
		).toThrow(AgentProtocolError);
	});

	// 实测失败模式：模型对 unknown 类判断省略 evidenceIds，并且偶尔漏写 summary。
	// 两者都不该让整轮判断失败，但 fact/statement 的证据约束必须继续生效。
	it('tolerates an omitted evidenceIds on an unknown claim and a missing summary', () => {
		const board = {
			caseId: 'case-1',
			title: '宿舍',
			goal: '入住',
			stage: 'understanding',
			currentBlocker: '房间未知',
			claims: [{ id: 'unknown-1', kind: 'unknown', text: '房间是否分配仍未知' }],
			participants: [],
			keyCompleter: null,
			nextAction: null,
			externalClues: [],
			updatedAt: new Date().toISOString()
		};
		const parsed = parseAgentAction(JSON.stringify({ type: 'propose_board_patch', board })) as {
			summary: string;
			board: { claims: Array<{ evidenceIds: string[] }> };
		};
		expect(parsed.summary).toBe('更新背景板');
		expect(parsed.board.claims[0].evidenceIds).toEqual([]);
	});

	it('still rejects a fact or statement that omits evidenceIds', () => {
		for (const kind of ['fact', 'statement']) {
			const board = {
				caseId: 'case-1',
				title: '宿舍',
				goal: '入住',
				stage: 'understanding',
				currentBlocker: '房间未知',
				claims: [{ id: 'c1', kind, text: '房间已经分配' }],
				participants: [],
				keyCompleter: null,
				nextAction: null,
				externalClues: [],
				updatedAt: new Date().toISOString()
			};
			expect(() =>
				parseAgentAction(JSON.stringify({ type: 'propose_board_patch', board }))
			).toThrow(AgentProtocolError);
		}
	});
});
