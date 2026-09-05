import { z } from 'zod';

import { dormDemoEvidence } from '$lib/domain/demo-case';
import { appendEvidenceInputSchema, createCaseInputSchema } from '$lib/domain/schemas';
import type { AgentEvent, CaseRecord } from '$lib/domain/types';
import { redactText, type RedactionReplacement } from '$lib/privacy/redact';
import { buildDormDemoFallback } from '$lib/server/agent/fallback';
import type { AgentRunResult } from '$lib/server/agent/runtime';
import { validateBoardForCase } from '$lib/server/agent/tools';
import { CaseNotFoundError, type CaseRepository } from '$lib/server/cases/repository';

const replacementSchema = z.object({ from: z.string().min(1), to: z.string() }).strict();
const serviceCreateSchema = createCaseInputSchema.extend({
	evidence: z.array(appendEvidenceInputSchema).max(20).default([]),
	replacements: z.array(replacementSchema).max(30).default([])
});
const serviceEvidenceSchema = appendEvidenceInputSchema.extend({
	replacements: z.array(replacementSchema).max(30).default([])
});

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
			const confusion = redactText(parsed.confusion, replacements);
			const caseRecord = repository.createCase({
				title: parsed.title,
				goal: parsed.goal,
				confusion: confusion.redacted
			});
			let redactionCount = confusion.findings.length;
			for (const inputEvidence of parsed.evidence) {
				const content = redactText(inputEvidence.content, replacements);
				redactionCount += content.findings.length;
				repository.appendEvidence(caseRecord.id, { ...inputEvidence, content: content.redacted });
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
			let run = await runner.run(caseRecord.id);
			const analyzed = requireCase(caseRecord.id);
			if (!analyzed.board) {
				const fallback = buildDormDemoFallback(analyzed);
				if (!fallback) throw new Error('内置演示案例数据不完整');
				validateBoardForCase(fallback, analyzed, fallback.externalClues);
				const saved = repository.saveBoard(analyzed.id, analyzed.revision, fallback);
				const summary = '通用 Agent 本轮选择继续追问，演示案例改用已审核的完整分析结果';
				repository.appendEvent(analyzed.id, {
					type: 'agent.fallback',
					payload: { summary }
				});
				run = {
					outcome: 'fallback',
					summary,
					turns: run.turns,
					revision: saved.revision
				};
			}
			return { ...view(caseRecord.id), run };
		},

		listCases: () => repository.listCases(),

		getCase: view,

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
			const evidence = repository.appendEvidence(caseId, {
				kind: parsed.kind,
				content: content.redacted,
				sourceLabel: parsed.sourceLabel,
				occurredAt: parsed.occurredAt
			});
			repository.appendEvent(caseId, {
				type: 'evidence.added',
				payload: {
					evidenceId: evidence.id,
					kind: evidence.kind,
					redactionCount: content.findings.length
				}
			});
			const run = await runner.run(caseId);
			return { ...view(caseId), run, redactionCount: content.findings.length };
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
