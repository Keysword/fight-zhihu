import { z } from 'zod';

import { guidanceDraftSchema } from '$lib/domain/guidance';
import { AgentProtocolError, parseJsonObject } from './protocol';

const searchZhihuActionSchema = z
	.object({
		type: z.literal('search_zhihu'),
		query: z.string().trim().min(1).max(300),
		count: z.number().int().min(1).max(10)
	})
	.strict();

const searchGlobalActionSchema = z
	.object({
		type: z.literal('search_global'),
		query: z.string().trim().min(1).max(300),
		count: z.number().int().min(1).max(20)
	})
	.strict();

const provideGuidanceActionSchema = z
	.object({
		type: z.literal('provide_guidance'),
		guidance: guidanceDraftSchema
	})
	.strict();

export const guidanceActionSchema = z.discriminatedUnion('type', [
	searchZhihuActionSchema,
	searchGlobalActionSchema,
	provideGuidanceActionSchema
]);

export type GuidanceAction = z.infer<typeof guidanceActionSchema>;

export function parseGuidanceAction(response: string): GuidanceAction {
	const result = guidanceActionSchema.safeParse(parseJsonObject(response));
	if (!result.success) {
		const detail = result.error.issues
			.slice(0, 3)
			.map((issue) => `${issue.path.join('.') || '(根)'}: ${issue.message}`)
			.join('；');
		throw new AgentProtocolError(`指导动作不符合协议：${detail}`, result.error);
	}
	return result.data;
}

export type GuidanceActionEnvelope =
	| { kind: 'action'; action: GuidanceAction }
	| { kind: 'salvageable'; raw: unknown; reason: string };

/**
 * Parses an action, but when the reply is a recognisable `provide_guidance` whose payload fails
 * the strict contract, hands the raw guidance back so the salvage pass can still use it.
 * Anything else — bad JSON, unknown action, missing guidance — remains a protocol error.
 */
export function parseGuidanceActionEnvelope(response: string): GuidanceActionEnvelope {
	const payload = parseJsonObject(response);
	const result = guidanceActionSchema.safeParse(payload);
	if (result.success) return { kind: 'action', action: result.data };

	const record = payload as Record<string, unknown>;
	const guidance = record.guidance;
	if (record.type === 'provide_guidance' && guidance !== undefined && guidance !== null) {
		const detail = result.error.issues
			.slice(0, 3)
			.map((issue) => `${issue.path.join('.') || '(根)'}: ${issue.message}`)
			.join('；');
		return { kind: 'salvageable', raw: guidance, reason: `指导动作不符合协议：${detail}` };
	}

	const detail = result.error.issues
		.slice(0, 3)
		.map((issue) => `${issue.path.join('.') || '(根)'}: ${issue.message}`)
		.join('；');
	throw new AgentProtocolError(`指导动作不符合协议：${detail}`, result.error);
}
