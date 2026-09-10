import { z } from 'zod';

import { dormDemoEvidence } from '$lib/domain/demo-case';
import {
	appendEvidenceInputSchema,
	confirmationKindSchema,
	createCaseInputSchema
} from '$lib/domain/schemas';
import type { AgentEvent, CaseRecord } from '$lib/domain/types';
import { redactText, type RedactionReplacement } from '$lib/privacy/redact';
import { buildDormDemoFallback } from '$lib/server/agent/fallback';
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
const proposalReviewSchema = z
	.object({
		action: z.enum(['confirm', 'discard']),
		expectedRevision: z.number().int().nonnegative()
	})
	.strict();

export interface AgentRunner {
	run(caseId: string): Promise<AgentRunResult>;
}

export interface CaseView {
	case: CaseRecord;
	events: AgentEvent[];
}

export interface CaseServiceConfiguration {
	modelConfigured: boolean;
	zhihuConfigured: boolean;
	version: string;
}

export function createCaseService(dependencies: {
	repository: CaseRepository;
	runner: AgentRunner;
	configuration: CaseServiceConfiguration;
}) {
	const { repository, runner, configuration } = dependencies;

	function requireCase(caseId: string): CaseRecord {
		const caseRecord = repository.getCase(caseId);
		if (!caseRecord) throw new CaseNotFoundError(caseId);
		return caseRecord;
	}

	function view(caseId: string): CaseView {
		return { case: requireCase(caseId), events: repository.listEvents(caseId) };
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

		async createDemo(): Promise<CaseView & { run: AgentRunResult }> {
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

		async runCase(caseId: string): Promise<CaseView & { run: AgentRunResult }> {
			requireCase(caseId);
			const run = await runner.run(caseId);
			return { ...view(caseId), run };
		},

		async appendEvidenceAndRun(
			caseId: string,
			input: z.input<typeof serviceEvidenceSchema>
		): Promise<CaseView & { run: AgentRunResult; redactionCount: number }> {
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
