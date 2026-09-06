import type { ExternalClue } from '$lib/domain/types';
import { redactSearchQuery } from '$lib/privacy/redact';
import type { CaseRepository } from '$lib/server/cases/repository';
import type { ZhihuClient } from '$lib/server/zhihu/client';
import { buildDormDemoFallback } from './fallback';
import { ModelConfigurationError, type ModelClient, type ModelMessage } from './model-client';
import { buildAgentMessages } from './prompt';
import { parseAgentAction, type AgentAction } from './protocol';
import { validateBoardForCase } from './tools';

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
	outcome: 'finished' | 'needs_input' | 'fallback' | 'failed' | 'review_required';
	summary: string;
	question?: string;
	proposedBoard?: import('$lib/domain/types').BackgroundBoard;
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
		if (caseRecord.board) {
			repository.stageBoardProposal(caseId, caseRecord.revision, fallback);
			repository.appendEvent(caseId, {
				type: 'agent.fallback',
				payload: { summary: '演示案例形成了一份待确认的已审核更新' }
			});
			return {
				outcome: 'review_required',
				summary: '演示案例形成了一份待确认的已审核更新',
				proposedBoard: fallback,
				turns: 0,
				revision: caseRecord.revision
			};
		}
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

			const existingEvents = repository.listEvents(caseId);
			const isDemo = existingEvents.some((event) => event.type === 'case.demo');
			const messages = buildAgentMessages(caseRecord, existingEvents);
			const gatheredClues: ExternalClue[] = [];
			const requiresReview = Boolean(caseRecord.board);
			let proposedBoard: import('$lib/domain/types').BackgroundBoard | undefined;
			let searchCount = 0;
			let protocolRepairUsed = false;

			for (let turn = 1; turn <= MAX_TURNS; turn += 1) {
				let rawAction: string;
				try {
					rawAction = await model.complete(messages);
				} catch (error) {
					if (turn === 1) return useDemoFallback(caseId, error);
					throw error;
				}
				let action: AgentAction;
				try {
					action = parseAgentAction(rawAction);
				} catch (error) {
					const protocolReason = error instanceof Error ? error.message : '未知协议错误';
					if (!protocolRepairUsed) {
						protocolRepairUsed = true;
						repository.appendEvent(caseId, {
							type: 'agent.protocol_repair',
							payload: {
								summary: '模型输出格式不合规，已要求其重新提交动作 JSON',
								reason: protocolReason
							}
						});
						messages.push({ role: 'assistant', content: rawAction });
						messages.push({
							role: 'user',
							content:
								'你刚才的输出没有通过动作协议。不要解释、不要复述分析，只重新输出一个合法的动作 JSON：search_zhihu、search_global、propose_board_patch、ask_user 或 finish。'
						});
						continue;
					}
					repository.appendEvent(caseId, {
						type: 'agent.error',
						payload: {
							category: 'protocol',
							summary: '模型连续两次没有返回合法动作 JSON',
							reason: protocolReason
						}
					});
					throw error;
				}
				if (action.type === 'search_zhihu' || action.type === 'search_global') {
					const caseSpecificNames: string[] = [
						...caseRecord.evidence.map((evidence) => evidence.sourceLabel),
						...(caseRecord.board?.participants.map((participant) => participant.name) ?? [])
					];
					action = { ...action, query: redactSearchQuery(action.query, caseSpecificNames) };
				}
				repository.appendEvent(caseId, {
					type: 'agent.action',
					payload: actionEventPayload(action)
				});
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
						let clues: ExternalClue[];
						try {
							clues =
								action.type === 'search_zhihu'
									? await zhihu.searchZhihu(action.query, action.count)
									: await zhihu.searchGlobal(action.query, action.count);
						} catch {
							const payload = {
								tool: action.type,
								unavailable: true,
								summary: '外部搜索暂时不可用，请继续基于案例证据判断'
							};
							repository.appendEvent(caseId, { type: 'tool.error', payload });
							messages.push(toolMessage(payload));
							break;
						}
						gatheredClues.push(...clues);
						const payload = { tool: action.type, clues };
						repository.appendEvent(caseId, { type: 'tool.result', payload });
						messages.push(toolMessage(payload));
						break;
					}

					case 'propose_board_patch': {
						validateBoardForCase(action.board, caseRecord, gatheredClues);
						if (requiresReview) {
							const staged = repository.stageBoardProposal(
								caseId,
								caseRecord.revision,
								action.board
							);
							proposedBoard = staged.pendingBoard ?? action.board;
							caseRecord = { ...staged, board: proposedBoard };
						} else {
							caseRecord = repository.saveBoard(caseId, caseRecord.revision, action.board);
						}
						const payload = {
							tool: action.type,
							revision: caseRecord.revision,
							saved: !requiresReview,
							pendingReview: requiresReview
						};
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
							outcome: proposedBoard ? 'review_required' : 'needs_input',
							summary: proposedBoard
								? '请先审阅本轮背景板变化，并补充一项关键信息'
								: '需要补充一项关键信息',
							question: action.question,
							proposedBoard,
							turns: turn,
							revision: caseRecord.revision
						};

					case 'finish':
						if (!caseRecord.board) {
							repository.appendEvent(caseId, {
								type: 'agent.invalid_finish',
								payload: { summary: '背景板尚未形成，不能结束本轮判断' }
							});
							messages.push(
								toolMessage({
									error:
										'当前还没有背景板。请先 propose_board_patch，或 ask_user 补充一个关键问题。'
								})
							);
							break;
						}
						if (proposedBoard) {
							repository.appendEvent(caseId, {
								type: 'agent.finished',
								payload: { outcome: 'review_required', summary: action.summary }
							});
							return {
								outcome: 'review_required',
								summary: action.summary,
								proposedBoard,
								turns: turn,
								revision: caseRecord.revision
							};
						}
						if (requiresReview && isDemo) {
							return useDemoFallback(caseId, new Error('演示更新需要形成可审阅的背景板'));
						}
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
