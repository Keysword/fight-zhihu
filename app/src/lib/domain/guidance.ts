import { z } from 'zod';
import type { ExternalClue } from './types';

const textSchema = z.string().trim().min(1).max(1200);

export const sourceRefSchema = z
	.object({
		kind: z.enum(['evidence', 'input', 'external']),
		id: z.string().min(1)
	})
	.strict();

export const caseInputSchema = z
	.object({
		kind: z.enum(['context', 'correction', 'constraint', 'action_result', 'question']),
		content: z.string().trim().min(1).max(5000),
		guidanceId: z.string().min(1).nullable().default(null),
		requestId: z.string().uuid()
	})
	.strict();

const understandingSchema = z
	.object({
		summary: textSchema,
		openPoint: textSchema.nullable(),
		sources: z.array(sourceRefSchema).max(12).default([])
	})
	.strict();

/**
 * The necessary layer: what has to survive for a run to be worth showing at all.
 * Everything else is optional and may be dropped one block at a time.
 */
export const understandingCoreSchema = z
	.object({
		summary: textSchema,
		openPoint: textSchema.nullable().default(null),
		sources: z.array(sourceRefSchema).max(12).default([])
	})
	.strip();

export const guidanceCompletenessSchema = z.enum(['full', 'partial', 'minimal']);

export const droppedGuidanceFieldSchema = z
	.object({
		field: z.enum([
			'understanding.summary',
			'understanding.openPoint',
			'understanding.sources',
			'communicationChecks',
			'nextStep',
			'question',
			'changeSummary',
			'unknownFields'
		]),
		reason: z.enum(['schema', 'reference']),
		detail: z.string().min(1).max(600)
	})
	.strict();

const communicationCheckSchema = z
	.object({
		observation: textSchema,
		possibleMisreading: textSchema,
		whyItMatters: textSchema,
		howToCheck: textSchema,
		sources: z.array(sourceRefSchema).min(1).max(12)
	})
	.strict();

const contactSchema = z
	.object({
		label: textSchema,
		basis: z.enum(['case_material', 'suggested_role']),
		sources: z.array(sourceRefSchema).max(12).default([])
	})
	.strict();

const branchSchema = z
	.object({
		when: textSchema,
		then: textSchema
	})
	.strict();

const nextStepSchema = z
	.object({
		kind: z.enum(['contact', 'inspect', 'wait', 'answer']),
		instruction: textSchema,
		why: textSchema,
		contact: contactSchema.nullable(),
		message: textSchema.nullable(),
		branches: z.array(branchSchema).max(2).default([])
	})
	.strict();

function hasLocalSource(sources: SourceRef[]): boolean {
	return sources.some((source) => source.kind === 'evidence' || source.kind === 'input');
}

export const guidanceDraftSchema = z
	.object({
		understanding: understandingSchema,
		communicationChecks: z.array(communicationCheckSchema).max(2).default([]),
		nextStep: nextStepSchema.nullable(),
		question: textSchema.nullable(),
		changeSummary: textSchema.nullable()
	})
	.strict()
	.superRefine((draft, context) => {
		if (draft.nextStep?.kind === 'contact' && draft.nextStep.contact === null) {
			context.addIssue({
				code: 'custom',
				path: ['nextStep', 'contact'],
				message: 'contact 动作必须指定联系人'
			});
		}

		if (draft.nextStep?.kind === 'answer' && draft.question === null) {
			context.addIssue({
				code: 'custom',
				path: ['question'],
				message: 'answer 动作必须有对应问题'
			});
		}

		draft.communicationChecks.forEach((check, index) => {
			if (!hasLocalSource(check.sources)) {
				context.addIssue({
					code: 'custom',
					path: ['communicationChecks', index, 'sources'],
					message: '沟通疑点必须至少关联一条证据或输入'
				});
			}
		});

		const contact = draft.nextStep?.contact;
		if (contact?.basis === 'case_material' && !hasLocalSource(contact.sources)) {
			context.addIssue({
				code: 'custom',
				path: ['nextStep', 'contact', 'sources'],
				message: '基于事项材料的联系人必须至少关联一条证据或输入'
			});
		}
	});

export {
	communicationCheckSchema,
	contactSchema,
	nextStepSchema,
	understandingSchema,
	textSchema
};

export type SourceRef = z.infer<typeof sourceRefSchema>;
export type CaseInputRequest = z.infer<typeof caseInputSchema>;
export type GuidanceDraft = z.infer<typeof guidanceDraftSchema>;
export type GuidanceCompleteness = z.infer<typeof guidanceCompletenessSchema>;
export type DroppedGuidanceField = z.infer<typeof droppedGuidanceFieldSchema>;

export interface CaseInput extends CaseInputRequest {
	id: string;
	caseId: string;
	contextRevision: number;
	createdAt: string;
}

export interface GuidanceSnapshot {
	id: string;
	caseId: string;
	runId: string;
	contextRevision: number;
	createdAt: string;
	draft: GuidanceDraft;
	externalClues: ExternalClue[];
	completeness: GuidanceCompleteness;
	dropped: DroppedGuidanceField[];
}
