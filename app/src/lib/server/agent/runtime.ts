import type { ExternalClue } from '$lib/domain/types';
import { redactSearchQuery } from '$lib/privacy/redact';
import type { CaseRepository } from '$lib/server/cases/repository';
import type { ZhihuClient } from '$lib/server/zhihu/client';
import { buildDormDemoFallback } from './fallback';
import { ModelConfigurationError, type ModelClient, type ModelMessage } from './model-client';
import { buildAgentMessages } from './prompt';
import { parseAgentAction, type AgentAction } from './protocol';
import { validateBoardForCase, AgentSafetyError } from './tools';

const MAX_TURNS = 6;
const MAX_SEARCHES = 2;

export { AgentSafetyError } from './tools';
export type { AgentErrorCode } from './tools';

export class AgentLimitError extends Error {
	readonly code: 'TURN_LIMIT_REACHED' | 'SEARCH_LIMIT_REACHED';

	constructor(message: string, code: 'TURN_LIMIT_REACHED' | 'SEARCH_LIMIT_REACHED') {
		super(message);
		this.name = 'AgentLimitError';
		this.code = code;
	}
}

export interface AgentRunErrorDetail {
	code: string;
	title: string;
	summary: string;
	suggestion: string;
}

export interface AgentRunResult {
	outcome: 'finished' | 'needs_input' | 'fallback' | 'failed' | 'review_required' | 'partial';
	summary: string;
	question?: string;
	proposedBoard?: import('$lib/domain/types').BackgroundBoard;
	error?: AgentRunErrorDetail;
	turns: number;
	revision: number;
}

/**
 * 把运行期错误翻译成"用户能看懂、开发能定位"的结构化信息。
 * 这是失败原因第一次真正到达用户界面和事件流。
 */
export function runErrorDetail(error: unknown): AgentRunErrorDetail {
	if (error instanceof AgentSafetyError) {
		return {
			code: error.code,
			title: '模型输出未通过安全校验',
			summary: error.message,
			suggestion: '补充或确认相关证据后重新分析；模型会在下一轮按校验原因自行修正。'
		};
	}
	if (error instanceof AgentLimitError) {
		return {
			code: error.code,
			title: '本轮决策次数用尽',
			summary: error.message,
			suggestion: '材料较多时可以分批补充证据，或稍后重新运行本轮分析。'
		};
	}
	if (error instanceof ModelConfigurationError) {
		return {
			code: 'MODEL_NOT_CONFIGURED',
			title: '尚未配置分析模型',
			summary: error.message,
			suggestion: '配置 AGENT_* 或 OpenCode Server 后重新分析；预置演示案例不受影响。'
		};
	}
	return {
		code: 'AGENT_RUN_FAILED',
		title: '本轮分析没有完成',
		summary: error instanceof Error ? error.message : '本轮分析遇到未知问题',
		suggestion: '材料已经保存，可以稍后重新运行本轮分析。'
	};
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
			let safetyRepairUsed = false;

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
							throw new AgentLimitError('单轮最多执行两次外部搜索', 'SEARCH_LIMIT_REACHED');
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
						try {
							validateBoardForCase(action.board, caseRecord, gatheredClues);
						} catch (error) {
							if (!(error instanceof AgentSafetyError)) throw error;
							const reason = error.message;
							if (safetyRepairUsed) {
								repository.appendEvent(caseId, {
									type: 'agent.error',
									payload: {
										category: 'safety',
										summary: '模型连续两次提交了未通过安全校验的背景板',
										reason
									}
								});
								throw error;
							}
							safetyRepairUsed = true;
							repository.appendEvent(caseId, {
								type: 'agent.safety_repair',
								payload: {
									summary: '背景板未通过安全校验，已要求模型按具体原因修正后重新提交',
									reason
								}
							});
							messages.push(
								toolMessage({
									error: '背景板没有通过安全校验',
									reason,
									instruction:
										'请只修正被指出的问题，其余字段保持原样，然后重新输出一个完整的 propose_board_patch 动作 JSON。'
								})
							);
							// 修复回合不占用本轮的决策预算。
							turn -= 1;
							break;
						}
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
			if (caseRecord.board) {
				// 已经有可校验的背景板时，预算耗尽不应该让用户什么都拿不到。
				repository.appendEvent(caseId, {
					type: 'agent.finished',
					payload: {
						outcome: 'partial',
						summary: `本轮达到 ${MAX_TURNS} 次决策上限，当前背景板可用但可能尚未整理完`
					}
				});
				return {
					outcome: 'partial',
					summary: `本轮达到 ${MAX_TURNS} 次决策上限，当前背景板可用但可能尚未整理完`,
					// 只有真正进入待审流程的更新才能作为 proposedBoard 返回。
					// 已落库的板由 case.board 携带；否则前端会把已生效的状态当成待确认提案。
					proposedBoard,
					turns: MAX_TURNS,
					revision: caseRecord.revision
				};
			}
			if (isDemo)
				return useDemoFallback(
					caseId,
					new AgentLimitError('演示案例达到决策上限', 'TURN_LIMIT_REACHED')
				);
			throw new AgentLimitError(`单轮最多执行 ${MAX_TURNS} 次 Agent 决策`, 'TURN_LIMIT_REACHED');
		}
	};
}
