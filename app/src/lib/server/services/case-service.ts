import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { dormDemoEvidence } from '$lib/domain/demo-case';
import { caseInputSchema, guidanceDraftSchema } from '$lib/domain/guidance';
import type { CaseInput, GuidanceSnapshot } from '$lib/domain/guidance';
import {
	appendEvidenceInputSchema,
	confirmationKindSchema,
	createCaseInputSchema
} from '$lib/domain/schemas';
import type { AgentEvent, CaseRecord } from '$lib/domain/types';
import { redactText, type RedactionReplacement } from '$lib/privacy/redact';
import { buildDormDemoFallback } from '$lib/server/agent/fallback';
import type { GuidanceRunResult } from '$lib/server/agent/guidance-runtime';
import { runErrorDetail, type AgentRunResult } from '$lib/server/agent/runtime';
import { validateBoardForCase } from '$lib/server/agent/tools';
import { CaseNotFoundError, type CaseRepository } from '$lib/server/cases/repository';

const replacementSchema = z.object({ from: z.string().min(1), to: z.string() }).strict();
const serviceCreateSchema = createCaseInputSchema.extend({
	evidence: z.array(appendEvidenceInputSchema).max(20).default([]),
	replacements: z.array(replacementSchema).max(30).default([])
});
const serviceEvidenceSchema = appendEvidenceInputSchema.extend({
	confirmation: confirmationKindSchema.default('self_reported'),
	replacements: z.array(replacementSchema).max(30).default([])
});
const serviceCaseInputSchema = caseInputSchema.extend({
	replacements: z.array(replacementSchema).max(30).default([])
});
const proposalReviewSchema = z
	.object({
		action: z.enum(['confirm', 'discard']),
		expectedRevision: z.number().int().nonnegative()
	})
	.strict();

export interface AgentRunner {
	run(caseId: string): Promise<AgentRunResult>;
}

export interface GuidanceRunner {
	run(caseId: string): Promise<GuidanceRunResult>;
}

export interface CaseView {
	mode: 'legacy' | 'guided';
	case: CaseRecord;
	events: AgentEvent[];
	inputs: CaseInput[];
	guidance: GuidanceSnapshot | null;
	guidanceHistory: GuidanceSnapshot[];
	contextRevision: number;
}

export interface CaseServiceConfiguration {
	guidanceMode: boolean;
	modelConfigured: boolean;
	zhihuConfigured: boolean;
	version: string;
}

export function createCaseService(dependencies: {
	repository: CaseRepository;
	runner: AgentRunner;
	guidanceRunner: GuidanceRunner;
	configuration: CaseServiceConfiguration;
}) {
	const { repository, runner, guidanceRunner, configuration } = dependencies;

	function requireCase(caseId: string): CaseRecord {
		const caseRecord = repository.getCase(caseId);
		if (!caseRecord) throw new CaseNotFoundError(caseId);
		return caseRecord;
	}

	function view(caseId: string): CaseView {
		const context = repository.getCaseContext(caseId);
		return {
			mode: configuration.guidanceMode ? 'guided' : 'legacy',
			case: requireCase(caseId),
			events: repository.listEvents(caseId),
			inputs: repository.listCaseInputs(caseId),
			guidance: repository.getCurrentGuidance(caseId),
			guidanceHistory: repository.listGuidance(caseId),
			contextRevision: context.contextRevision
		};
	}

	function buildDormDemoGuidance(caseRecord: CaseRecord) {
		const sources = caseRecord.evidence.map((evidence) => ({
			kind: 'evidence' as const,
			id: evidence.id
		}));
		return guidanceDraftSchema.parse({
			understanding: {
				summary: '固定宿舍演示样例：已有接引安排，但接引安排不能证明已经具备实际入住条件。',
				openPoint: '房间是否分配、钥匙由谁交付仍需负责方确认。',
				sources
			},
			communicationChecks: [
				{
					observation: '部门安排了接引同事。',
					possibleMisreading: '把能够进入园区理解为已经能够入住。',
					whyItMatters: '没有房间和钥匙信息时，到达后仍可能无法入住。',
					howToCheck: '向人力或住宿管理方确认房间分配和钥匙交付。',
					sources
				}
			],
			nextStep: {
				kind: 'contact',
				instruction: '联系人力或住宿管理方，确认房间和钥匙安排。',
				why: '这两项信息直接决定到达后能否实际入住。',
				contact: { label: '人力 / 住宿管理方', basis: 'case_material', sources },
				message:
					'您好，我计划在 8 月 2 日 16:00 到达，目前已安排接引，但还没有收到房间和钥匙信息。请问房间是否已经分配，当天钥匙由谁交付？',
				branches: [
					{ when: '房间和钥匙均已确认', then: '记录房间号、交付人和交付时间后前往。' },
					{ when: '尚未确认', then: '询问预计确认时间，并据此调整到达安排。' }
				]
			},
			question: null,
			changeSummary: '固定演示样例'
		});
	}

	return {
		createCase(input: z.input<typeof serviceCreateSchema>) {
			const parsed = serviceCreateSchema.parse(input);
			const replacements = parsed.replacements as RedactionReplacement[];
			let redactionCount = 0;
			const redact = (text: string) => {
				const result = redactText(text, replacements);
				redactionCount += result.findings.length;
				return result.redacted;
			};
			const caseRecord = repository.createCase({
				title: redact(parsed.title),
				goal: redact(parsed.goal),
				confusion: redact(parsed.confusion)
			});
			for (const inputEvidence of parsed.evidence) {
				repository.appendEvidence(caseRecord.id, {
					...inputEvidence,
					content: redact(inputEvidence.content),
					sourceLabel: redact(inputEvidence.sourceLabel)
				});
			}
			repository.appendEvent(caseRecord.id, {
				type: 'case.created',
				payload: { evidenceCount: parsed.evidence.length, redactionCount }
			});
			return { ...view(caseRecord.id), redactionCount };
		},

		async createDemo(): Promise<CaseView & { run: AgentRunResult | GuidanceRunResult }> {
			const caseRecord = repository.createCase({
				title: '新人入住宿舍',
				goal: '确认 8 月 2 日到达后是否可以实际入住',
				confusion: '部门已安排接引，但没有房间号，也不知道钥匙由谁交付。'
			});
			for (const evidence of dormDemoEvidence) {
				repository.appendEvidence(caseRecord.id, {
					kind: evidence.kind,
					content: evidence.content,
					sourceLabel: evidence.sourceLabel,
					occurredAt: evidence.occurredAt
				});
			}
			repository.appendEvent(caseRecord.id, {
				type: 'case.demo',
				payload: { fixture: 'dorm', summary: '载入已匿名化的新人宿舍案例' }
			});
			if (configuration.guidanceMode) {
				let run: GuidanceRunResult | null = null;
				try {
					run = await guidanceRunner.run(caseRecord.id);
				} catch {
					// The fixed demo below remains available when the configured runtime itself fails.
				}
				if (!run?.guidance || run.outcome === 'failed') {
					const current = requireCase(caseRecord.id);
					const { contextRevision } = repository.getCaseContext(caseRecord.id);
					const saved = repository.saveGuidance(
						caseRecord.id,
						contextRevision,
						buildDormDemoGuidance(current),
						[],
						randomUUID()
					);
					repository.appendEvent(caseRecord.id, {
						type: 'guidance.demo_fallback',
						payload: { summary: '已载入固定宿舍 Guidance 演示样例' }
					});
					run = {
						runId: saved.snapshot.runId,
						outcome: 'ready',
						guidance: saved.snapshot,
						contextRevision,
						modelCallCount: run?.modelCallCount ?? 0,
						searchCount: run?.searchCount ?? 0,
						repairCount: run?.repairCount ?? 0
					};
				}
				return { ...view(caseRecord.id), run };
			}

			let run: AgentRunResult | null = null;
			let agentFailed = false;
			try {
				run = await runner.run(caseRecord.id);
			} catch {
				agentFailed = true;
			}
			const analyzed = requireCase(caseRecord.id);
			if (!analyzed.board || agentFailed) {
				const fallback = buildDormDemoFallback(analyzed);
				if (!fallback) throw new Error('内置演示案例数据不完整');
				let revision = analyzed.revision;
				if (!analyzed.board) {
					validateBoardForCase(fallback, analyzed, fallback.externalClues);
					revision = repository.saveBoard(analyzed.id, analyzed.revision, fallback).revision;
				}
				const summary = agentFailed
					? '通用 Agent 本轮未完成，演示案例改用已审核的完整分析结果'
					: '通用 Agent 本轮选择继续追问，演示案例改用已审核的完整分析结果';
				repository.appendEvent(analyzed.id, {
					type: 'agent.fallback',
					payload: { summary }
				});
				run = {
					outcome: 'fallback',
					summary,
					turns: run?.turns ?? 0,
					revision
				};
			}
			if (!run) throw new Error('演示案例未形成可展示结果');
			return { ...view(caseRecord.id), run };
		},

		listCases: () => repository.listCases(),

		getCase: view,

		/**
		 * 用户在证据轨上确认“这条是负责方明确回复过”。
		 * 确认本身不重新分析：板上的判断仍由用户决定是否重新运行。
		 */
		confirmEvidence(caseId: string, evidenceId: string): CaseView {
			const before = repository.getCaseContext(caseId).contextRevision;
			const evidence = repository.confirmEvidence(caseId, evidenceId);
			const after = repository.getCaseContext(caseId).contextRevision;
			if (after !== before) {
				repository.appendEvent(caseId, {
					type: 'evidence.confirmed',
					payload: { evidenceId: evidence.id, sourceLabel: evidence.sourceLabel }
				});
			}
			return view(caseId);
		},

		appendCaseInput(caseId: string, input: z.input<typeof serviceCaseInputSchema>) {
			requireCase(caseId);
			const parsed = serviceCaseInputSchema.parse(input);
			const redacted = redactText(parsed.content, parsed.replacements);
			const saved = repository.appendCaseInput(caseId, {
				kind: parsed.kind,
				content: redacted.redacted,
				guidanceId: parsed.guidanceId,
				requestId: parsed.requestId
			});
			if (saved.outcome === 'inserted') {
				repository.appendEvent(caseId, {
					type: 'case.input_added',
					payload: {
						inputId: saved.input.id,
						kind: saved.input.kind,
						guidanceId: saved.input.guidanceId,
						redactionCount: redacted.findings.length
					}
				});
			}
			return {
				...view(caseId),
				outcome: saved.outcome,
				input: saved.input,
				redactionCount: redacted.findings.length
			};
		},

		reviewBoardProposal(caseId: string, input: z.input<typeof proposalReviewSchema>): CaseView {
			const parsed = proposalReviewSchema.parse(input);
			const current = requireCase(caseId);
			if (parsed.action === 'confirm') {
				if (!current.pendingBoard) throw new Error('当前没有待确认的背景板更新');
				validateBoardForCase(current.pendingBoard, current, current.pendingBoard.externalClues);
				repository.confirmBoardProposal(caseId, parsed.expectedRevision);
				repository.appendEvent(caseId, {
					type: 'board.proposal_confirmed',
					payload: { revision: parsed.expectedRevision + 1 }
				});
			} else {
				repository.discardBoardProposal(caseId, parsed.expectedRevision);
				repository.appendEvent(caseId, {
					type: 'board.proposal_discarded',
					payload: { revision: parsed.expectedRevision }
				});
			}
			return view(caseId);
		},

		async runGuidance(caseId: string): Promise<CaseView & { run: GuidanceRunResult }> {
			requireCase(caseId);
			const run = await guidanceRunner.run(caseId);
			return { ...view(caseId), run };
		},

		async runCase(caseId: string): Promise<CaseView & { run: AgentRunResult | GuidanceRunResult }> {
			requireCase(caseId);
			const run = configuration.guidanceMode
				? await guidanceRunner.run(caseId)
				: await runner.run(caseId);
			return { ...view(caseId), run };
		},

		async appendEvidenceAndRun(
			caseId: string,
			input: z.input<typeof serviceEvidenceSchema>
		): Promise<CaseView & { run: AgentRunResult | GuidanceRunResult; redactionCount: number }> {
			requireCase(caseId);
			const parsed = serviceEvidenceSchema.parse(input);
			const content = redactText(parsed.content, parsed.replacements);
			const sourceLabel = redactText(parsed.sourceLabel, parsed.replacements);
			const evidence = repository.appendEvidence(caseId, {
				kind: parsed.kind,
				content: content.redacted,
				sourceLabel: sourceLabel.redacted,
				occurredAt: parsed.occurredAt,
				confirmation: parsed.confirmation
			});
			repository.appendEvent(caseId, {
				type: 'evidence.added',
				payload: {
					evidenceId: evidence.id,
					kind: evidence.kind,
					confirmation: evidence.confirmation,
					redactionCount: content.findings.length + sourceLabel.findings.length
				}
			});
			if (configuration.guidanceMode) {
				const run = await guidanceRunner.run(caseId);
				return {
					...view(caseId),
					run,
					redactionCount: content.findings.length + sourceLabel.findings.length
				};
			}

			let run: AgentRunResult;
			try {
				run = await runner.run(caseId);
			} catch (error) {
				const detail = runErrorDetail(error);
				const current = requireCase(caseId);
				repository.appendEvent(caseId, {
					type: 'agent.run_failed',
					payload: { title: detail.title, summary: detail.summary, suggestion: detail.suggestion }
				});
				run = {
					outcome: 'failed',
					summary: '证据已经保存，但 Agent 本轮暂时没有完成判断；可以稍后重新运行。',
					error: detail,
					turns: 0,
					revision: current.revision
				};
			}
			return {
				...view(caseId),
				run,
				redactionCount: content.findings.length + sourceLabel.findings.length
			};
		},

		health() {
			repository.listCases();
			return {
				version: configuration.version,
				databaseReady: true,
				modelConfigured: configuration.modelConfigured,
				zhihuConfigured: configuration.zhihuConfigured
			};
		}
	};
}

export type CaseService = ReturnType<typeof createCaseService>;
