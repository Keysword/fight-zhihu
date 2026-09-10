import { z } from 'zod';

export const evidenceKindSchema = z.enum(['message', 'email', 'notice', 'call', 'note']);
export const confirmationKindSchema = z.enum(['official', 'self_reported']);
export const caseStageSchema = z.enum([
	'collecting',
	'understanding',
	'waiting',
	'actionable',
	'resolved'
]);
export const confidenceSchema = z.enum(['low', 'medium', 'high']);
export const claimKindSchema = z.enum(['fact', 'statement', 'inference', 'unknown', 'conflict']);

export const evidenceSchema = z
	.object({
		id: z.string().min(1),
		kind: evidenceKindSchema,
		content: z.string().trim().min(1),
		sourceLabel: z.string().trim().min(1),
		occurredAt: z.string().datetime().nullable(),
		confirmation: confirmationKindSchema.default('self_reported')
	})
	.strict();

export const claimSchema = z
	.object({
		id: z.string().min(1),
		kind: claimKindSchema,
		text: z.string().trim().min(1),
		evidenceIds: z.array(z.string().min(1)),
		rationale: z.string().trim().optional(),
		relatedClaimIds: z.array(z.string().min(1)).optional()
	})
	.strict()
	.superRefine((claim, context) => {
		if ((claim.kind === 'fact' || claim.kind === 'statement') && claim.evidenceIds.length === 0) {
			context.addIssue({
				code: 'custom',
				path: ['evidenceIds'],
				message: '已确认事实或他人说法必须关联证据'
			});
		}
		if (claim.kind === 'inference' && !claim.rationale) {
			context.addIssue({
				code: 'custom',
				path: ['rationale'],
				message: 'AI 推断必须说明判断依据'
			});
		}
		if (claim.kind === 'conflict' && claim.evidenceIds.length < 2) {
			context.addIssue({
				code: 'custom',
				path: ['evidenceIds'],
				message: '冲突必须关联至少两条证据'
			});
		}
	});

export const participantSchema = z
	.object({
		id: z.string().min(1),
		name: z.string().trim().min(1),
		role: z.string().trim().min(1),
		providedInfo: z.array(z.string().trim().min(1)),
		capabilities: z.array(z.string().trim().min(1)),
		decisionScopes: z.array(z.string().trim().min(1)),
		coordinationScopes: z.array(z.string().trim().min(1)),
		evidenceIds: z.array(z.string().min(1))
	})
	.strict();

export const keyCompleterSchema = z
	.object({
		participantId: z.string().min(1),
		scope: z.string().trim().min(1),
		rationale: z.string().trim().min(1, '关键补全者必须说明判断依据'),
		confidence: confidenceSchema,
		uncertainty: z.string().trim().min(1, '关键补全者必须保留不确定性'),
		evidenceIds: z.array(z.string().min(1)).min(1)
	})
	.strict();

export const nextActionSchema = z
	.object({
		contactParticipantId: z.string().min(1),
		question: z.string().trim().min(1),
		why: z.string().trim().min(1),
		message: z.string().trim().min(1),
		branches: z.array(
			z
				.object({
					when: z.string().trim().min(1),
					then: z.string().trim().min(1)
				})
				.strict()
		)
	})
	.strict();

export const externalClueSchema = z
	.object({
		id: z.string().min(1),
		title: z.string().trim().min(1),
		excerpt: z.string(),
		url: z
			.string()
			.url()
			.refine((value) => /^https?:\/\//i.test(value), '外部线索只允许 HTTP(S) 链接'),
		author: z.string(),
		editedAt: z.string().datetime().nullable(),
		authorityLevel: z.string().nullable(),
		source: z.enum(['zhihu', 'global']),
		relevance: z.string(),
		warning: z.string().trim().min(1)
	})
	.strict();

export const backgroundBoardSchema = z
	.object({
		caseId: z.string().min(1),
		title: z.string().trim().min(1),
		goal: z.string().trim().min(1),
		stage: caseStageSchema,
		currentBlocker: z.string().trim().min(1),
		claims: z.array(claimSchema),
		participants: z.array(participantSchema),
		keyCompleter: keyCompleterSchema.nullable(),
		nextAction: nextActionSchema.nullable(),
		externalClues: z.array(externalClueSchema),
		updatedAt: z.string().datetime()
	})
	.strict();

export const createCaseInputSchema = z
	.object({
		title: z.string().trim().min(1).max(120),
		goal: z.string().trim().min(1).max(500),
		confusion: z.string().trim().min(1).max(2000)
	})
	.strict();

export const appendEvidenceInputSchema = z
	.object({
		kind: evidenceKindSchema,
		content: z.string().trim().min(1).max(30_000),
		sourceLabel: z.string().trim().min(1).max(120),
		occurredAt: z.string().datetime().nullable().default(null)
	})
	.strict();
