import { z } from 'zod';

import { backgroundBoardSchema } from '$lib/domain/schemas';

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

const proposeBoardActionSchema = z
	.object({
		type: z.literal('propose_board_patch'),
		board: backgroundBoardSchema,
		summary: z.string().trim().min(1).max(500)
	})
	.strict();

const askUserActionSchema = z
	.object({
		type: z.literal('ask_user'),
		question: z.string().trim().min(1).max(1_000)
	})
	.strict();

const finishActionSchema = z
	.object({
		type: z.literal('finish'),
		summary: z.string().trim().min(1).max(1_000)
	})
	.strict();

export const agentActionSchema = z.discriminatedUnion('type', [
	searchZhihuActionSchema,
	searchGlobalActionSchema,
	proposeBoardActionSchema,
	askUserActionSchema,
	finishActionSchema
]);

export type AgentAction = z.infer<typeof agentActionSchema>;

export class AgentProtocolError extends Error {
	constructor(
		message: string,
		readonly cause?: unknown
	) {
		super(message);
		this.name = 'AgentProtocolError';
	}
}

function extractJson(response: string): string {
	const trimmed = response.trim();
	if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
	const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
	if (fenced?.[1]) return fenced[1].trim();
	throw new AgentProtocolError('模型输出不是单个 JSON 动作');
}

export function parseAgentAction(response: string): AgentAction {
	let value: unknown;
	try {
		value = JSON.parse(extractJson(response));
	} catch (error) {
		if (error instanceof AgentProtocolError) throw error;
		throw new AgentProtocolError('模型输出不是有效 JSON', error);
	}

	const result = agentActionSchema.safeParse(value);
	if (!result.success) {
		throw new AgentProtocolError('模型动作不符合协议', result.error);
	}
	return result.data;
}
