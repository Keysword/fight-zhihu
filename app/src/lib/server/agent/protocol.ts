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
		// summary 只是给人看的动作说明，模型漏写时不该让整轮判断失败。
		summary: z.string().trim().min(1).max(500).default('更新背景板')
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

/**
 * 从模型输出里取出第一个完整的 JSON 对象。
 *
 * 真实模型经常在合法 JSON 之后追一句解释，或者在前面加一句开场白。
 * 只要动作对象本身完整，这类输出就应该被接受，而不是浪费一次修复回合。
 * 扫描时跟踪字符串状态与转义，避免把字符串里的花括号当成对象边界。
 */
function extractJson(response: string): string {
	const start = response.indexOf('{');
	if (start === -1) throw new AgentProtocolError('模型输出里没有 JSON 对象');
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < response.length; index += 1) {
		const character = response[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (character === '\\') escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') inString = true;
		else if (character === '{') depth += 1;
		else if (character === '}') {
			depth -= 1;
			if (depth === 0) return response.slice(start, index + 1);
		}
	}
	throw new AgentProtocolError('模型输出的 JSON 对象没有闭合');
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
		// 只说“不符合协议”无法定位问题：这里把出错的字段路径带出来，
		// 它会进入 agent.error 事件和用户可见的失败说明。
		const detail = result.error.issues
			.slice(0, 3)
			.map((issue) => `${issue.path.join('.') || '(根)'}: ${issue.message}`)
			.join('；');
		throw new AgentProtocolError(`模型动作不符合协议：${detail}`, result.error);
	}
	return result.data;
}
