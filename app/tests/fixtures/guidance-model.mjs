import { createServer } from 'node:http';

const PORT = 4789;
// 运行时默认 GUIDANCE_MODEL_MAX_RETRIES=2：耗尽 3 次尝试后才算整轮失败，
// 手动重试开启新的一轮才会放行。
const ATTEMPTS_BEFORE_FAILURE_CLEARED = 3;
// “慢速”标记案例的响应延迟：给“新版替代旧运行”的 E2E 留出竞态窗口。
const SLOW_RESPONSE_DELAY_MS = 4_000;
const failureCounts = new Map();
// “搜索失败”标记案例：每个 revision 第一次先请求搜索，随后再给指导。
const searchRequested = new Set();

function section(content, heading) {
	const match = content.match(new RegExp(`【${heading}】[^\\n]*\\n([^\\n]+)`));
	if (!match) return null;
	try {
		return JSON.parse(match[1]);
	} catch {
		return null;
	}
}

function guidanceAction(prompt) {
	const caseRecord = section(prompt, '案例目标与困惑') ?? {};
	const evidence = section(prompt, '用户原始材料') ?? [];
	const inputs = section(prompt, '持久化用户输入') ?? [];
	const latestInput = inputs.at(-1);
	const localSource = latestInput
		? { kind: 'input', id: latestInput.id }
		: evidence[0]
			? { kind: 'evidence', id: evidence[0].id }
			: null;
	const sources = localSource ? [localSource] : [];
	const title = String(caseRecord.title ?? '未命名案例');
	const revisionKey = `${caseRecord.id}:${caseRecord.contextRevision}`;

	if (title.includes('失败重试') && latestInput) {
		const failures = failureCounts.get(revisionKey) ?? 0;
		if (failures < ATTEMPTS_BEFORE_FAILURE_CLEARED) {
			failureCounts.set(revisionKey, failures + 1);
			return { status: 503, body: { error: 'scripted first-attempt failure' } };
		}
	}

	// “非法来源”标记：引用不存在的来源 id，触发引用修复/降级路径。
	if (title.includes('非法来源')) {
		sources.push({ kind: 'evidence', id: 'evidence-not-exist' });
	}

	if (title.includes('搜索失败') && !searchRequested.has(revisionKey)) {
		searchRequested.add(revisionKey);
		const content = JSON.stringify({ type: 'search_zhihu', query: '新人 入住 经验', count: 3 });
		return {
			status: 200,
			body: { choices: [{ message: { content }, finish_reason: 'stop' }] },
			content
		};
	}

	const asksQuestion = title.includes('追问') && inputs.length === 0;
	const hasConstraint = inputs.some((input) => String(input.content).includes('联系不上'));
	const hasActionResult = inputs.some((input) => String(input.content).includes('问过'));
	const latestContent = latestInput ? String(latestInput.content) : '';
	let summary = `先围绕“${caseRecord.goal}”形成一版可修正的理解。`;
	let changeSummary = null;
	if (hasConstraint && hasActionResult) {
		summary = '原建议中的联系人无法触达，而且用户已经问过原入口，下一步需要换一个可执行的突破点。';
		changeSummary = '根据联系限制和已经尝试过的动作，改为寻找替代入口。';
	} else if (hasConstraint) {
		summary = '原建议中的联系人目前无法触达，需要避开这条已经不可行的路径。';
		changeSummary = '根据“联系不上”的补充，停止重复建议原联系人。';
	} else if (latestInput) {
		summary = `已把你的最新补充“${latestContent}”纳入当前理解。`;
		changeSummary = '根据你的最新补充修正了理解和下一步。';
	}

	const question = asksQuestion ? '你已经向哪个入口问过，得到过什么回复？' : null;
	const nextStep = asksQuestion
		? {
				kind: 'answer',
				instruction: '先补充你已经尝试过的沟通。',
				why: '这能避免再次建议已经走不通的路径。',
				contact: null,
				message: null,
				branches: []
			}
		: {
				kind: 'contact',
				instruction: hasConstraint
					? '请从已有通知或组织通讯录中寻找一个替代经办入口。'
					: '先向一个可触达的经办入口核对决定下一步所需的信息。',
				why: hasConstraint
					? '原联系人已经不可达，换入口比继续等待更能推进事情。'
					: '先拿到一个会改变行动选择的回答。',
				contact: { label: '可尝试的经办入口', basis: 'suggested_role', sources: [] },
				message: hasConstraint
					? '您好，原对接人目前联系不上，想请问这件事还可以向哪个经办入口确认？'
					: '您好，我想确认目前的安排和下一步应联系的经办入口。',
				branches: [
					{ when: '得到明确入口', then: '向该入口核对具体安排。' },
					{ when: '仍没有入口', then: '记录未解决事项和截止时间。' }
				]
			};

	const content = JSON.stringify({
		type: 'provide_guidance',
		guidance: {
			understanding: {
				summary,
				openPoint: asksQuestion ? '用户已尝试过的沟通还不清楚。' : null,
				sources
			},
			communicationChecks: sources.length
				? [
						{
							observation: '现有说法只描述了一个沟通入口。',
							possibleMisreading: '这可能被理解成只有这个人能够推进事情。',
							whyItMatters: '一旦该入口不可达，用户会误以为事情只能停住。',
							howToCheck: '查看通知或通讯录里是否还有经办入口。',
							sources: sources.filter((source) => source.id !== 'evidence-not-exist')
						}
					]
				: [],
			nextStep,
			question,
			changeSummary
		}
	});

	return {
		status: 200,
		body: {
			choices: [
				{
					message: { content },
					finish_reason: 'stop'
				}
			]
		},
		content
	};
}

function sseChunk(delta, finishReason = null) {
	return `data: ${JSON.stringify({
		id: 'chatcmpl-e2e',
		object: 'chat.completion.chunk',
		choices: [{ index: 0, delta, finish_reason: finishReason }]
	})}\n\n`;
}

/** 以 SSE 形式回放同一脚本：先空 delta，再分段正文，最后 finish_reason=stop。 */
function writeSse(response, content) {
	response.writeHead(200, { 'Content-Type': 'text/event-stream' });
	response.write(sseChunk({ role: 'assistant', content: '' }));
	const midpoint = Math.max(1, Math.floor(content.length / 2));
	response.write(sseChunk({ content: content.slice(0, midpoint) }));
	response.write(sseChunk({ content: content.slice(midpoint) }));
	response.write(sseChunk({}, 'stop'));
	response.write('data: [DONE]\n\n');
	response.end();
}

const server = createServer((request, response) => {
	if (request.method === 'GET' && request.url === '/health') {
		response.writeHead(200, { 'Content-Type': 'application/json' });
		response.end(JSON.stringify({ ok: true }));
		return;
	}
	if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
		response.writeHead(404).end();
		return;
	}
	let rawBody = '';
	request.setEncoding('utf8');
	request.on('data', (chunk) => (rawBody += chunk));
	request.on('end', () => {
		try {
			const payload = JSON.parse(rawBody);
			const prompt = Array.isArray(payload.messages)
				? payload.messages.map((message) => String(message.content ?? '')).join('\n\n')
				: '';
			const result = guidanceAction(prompt);
			// “慢速”标记：延迟响应，让旧运行还在飞行时就能提交新输入。
			const delay = prompt.includes('慢速') ? SLOW_RESPONSE_DELAY_MS : 0;
			const respond = () => {
				if (payload.stream === true) {
					if (result.status !== 200) {
						response.writeHead(result.status, { 'Content-Type': 'application/json' });
						response.end(JSON.stringify(result.body));
						return;
					}
					writeSse(response, result.content);
					return;
				}
				response.writeHead(result.status, { 'Content-Type': 'application/json' });
				response.end(JSON.stringify(result.body));
			};
			if (delay > 0) setTimeout(respond, delay);
			else respond();
		} catch (error) {
			response.writeHead(400, { 'Content-Type': 'application/json' });
			response.end(
				JSON.stringify({ error: error instanceof Error ? error.message : 'bad request' })
			);
		}
	});
});

server.listen(PORT, '127.0.0.1');

function shutdown() {
	server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
