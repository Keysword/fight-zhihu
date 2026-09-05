import type { ExternalClue } from '$lib/domain/types';
import type { CaseRepository } from '$lib/server/cases/repository';
import type { ZhihuClient } from '$lib/server/zhihu/client';
import { buildDormDemoFallback } from './fallback';
import { ModelConfigurationError, type ModelClient, type ModelMessage } from './model-client';
import { buildAgentMessages } from './prompt';
import { parseAgentAction, type AgentAction } from './protocol';
import { AgentSafetyError, validateBoardForCase } from './tools';

const MAX_TURNS = 6;
const MAX_SEARCHES = 2;

export { AgentSafetyError } from './tools';

export class AgentLimitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AgentLimitError';
	}
}

export interface AgentRunResult {
	outcome: 'finished' | 'needs_input' | 'fallback';
	summary: string;
	question?: string;
	turns: number;
	revision: number;
}

interface RuntimeDependencies {
	repository: CaseRepository;
	model: ModelClient | null;
	zhihu: ZhihuClient;
}

function actionEventPayload(action: AgentAction): Record<string, unknown> {
	switch (action.type) {
		case 'search_zhihu':
		case 'search_global':
			return { action: action.type, query: action.query, count: action.count };
		case 'propose_board_patch':
			return { action: action.type, summary: action.summary };
		case 'ask_user':
			return { action: action.type, question: action.question };
		case 'finish':
			return { action: action.type, summary: action.summary };
	}
}

function toolMessage(payload: Record<string, unknown>): ModelMessage {
	return { role: 'user', content: `工具结果：${JSON.stringify(payload)}` };
}

export function createAgentRuntime(dependencies: RuntimeDependencies) {
	const { repository, model, zhihu } = dependencies;

	async function useDemoFallback(caseId: string, cause: unknown): Promise<AgentRunResult> {
		const caseRecord = repository.getCase(caseId);
		if (!caseRecord) throw cause;
		const isDemo = repository.listEvents(caseId).some((event) => event.type === 'case.demo');
		const fallback = isDemo ? buildDormDemoFallback(caseRecord) : null;
		if (!fallback) throw cause;
		validateBoardForCase(fallback, caseRecord, fallback.externalClues);
		const saved = repository.saveBoard(caseId, caseRecord.revision, fallback);
		repository.appendEvent(caseId, {
			type: 'agent.fallback',
			payload: { summary: '演示案例使用内置的已审核分析结果' }
		});
		return {
			outcome: 'fallback',
			summary: '演示案例使用内置的已审核分析结果',
			turns: 0,
			revision: saved.revision
		};
	}

	return {
		async run(caseId: string): Promise<AgentRunResult> {
			let caseRecord = repository.getCase(caseId);
			if (!caseRecord) throw new Error(`找不到案例：${caseId}`);
			if (!model) return useDemoFallback(caseId, new ModelConfigurationError());

			const messages = buildAgentMessages(caseRecord, repository.listEvents(caseId));
			const gatheredClues: ExternalClue[] = [];
			let searchCount = 0;

			for (let turn = 1; turn <= MAX_TURNS; turn += 1) {
				let rawAction: string;
				try {
					rawAction = await model.complete(messages);
				} catch (error) {
					if (turn === 1) return useDemoFallback(caseId, error);
					throw error;
				}
				const action = parseAgentAction(rawAction);
				repository.appendEvent(caseId, { type: 'agent.action', payload: actionEventPayload(action) });
				messages.push({ role: 'assistant', content: rawAction });

				switch (action.type) {
					case 'search_zhihu':
					case 'search_global': {
						if (searchCount >= MAX_SEARCHES) {
							repository.appendEvent(caseId, {
								type: 'agent.limit',
								payload: { limit: 'search', maximum: MAX_SEARCHES }
							});
							throw new AgentLimitError('单轮最多执行两次外部搜索');
						}
						searchCount += 1;
						const clues =
							action.type === 'search_zhihu'
								? await zhihu.searchZhihu(action.query, action.count)
								: await zhihu.searchGlobal(action.query, action.count);
						gatheredClues.push(...clues);
						const payload = { tool: action.type, clues };
						repository.appendEvent(caseId, { type: 'tool.result', payload });
						messages.push(toolMessage(payload));
						break;
					}

					case 'propose_board_patch': {
						validateBoardForCase(action.board, caseRecord, gatheredClues);
						caseRecord = repository.saveBoard(caseId, caseRecord.revision, action.board);
						const payload = { tool: action.type, revision: caseRecord.revision, saved: true };
						repository.appendEvent(caseId, { type: 'tool.result', payload });
						messages.push(toolMessage(payload));
						break;
					}

					case 'ask_user':
						repository.appendEvent(caseId, {
							type: 'agent.finished',
							payload: { outcome: 'needs_input', question: action.question }
						});
						return {
							outcome: 'needs_input',
							summary: '需要补充一项关键信息',
							question: action.question,
							turns: turn,
							revision: caseRecord.revision
						};

					case 'finish':
						repository.appendEvent(caseId, {
							type: 'agent.finished',
							payload: { outcome: 'finished', summary: action.summary }
						});
						return {
							outcome: 'finished',
							summary: action.summary,
							turns: turn,
							revision: caseRecord.revision
						};
				}
			}

			repository.appendEvent(caseId, {
				type: 'agent.limit',
				payload: { limit: 'turn', maximum: MAX_TURNS }
			});
			throw new AgentLimitError(`单轮最多执行 ${MAX_TURNS} 次 Agent 决策`);
		}
	};
}
