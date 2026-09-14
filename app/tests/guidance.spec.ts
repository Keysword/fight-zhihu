import { randomUUID } from 'node:crypto';
import { expect, type Page, type APIRequestContext, test } from '@playwright/test';

const BASE = '/background-board';

async function createGuidedCase(
	page: Page,
	values: { title: string; goal?: string; confusion?: string; evidence?: string }
) {
	await page.goto(`${BASE}/cases/new`);
	await page.getByLabel('给这件事起个短标题').fill(values.title);
	await page.getByLabel('你最终想做到什么？').fill(values.goal ?? '找到一个可以继续推进的入口');
	await page
		.getByLabel('现在最让你困惑的地方')
		.fill(values.confusion ?? '现有说法没有说明下一步应该找谁。');
	await page
		.getByLabel('先放一段原材料（可选）')
		.fill(values.evidence ?? '同事说可以找原对接人问问。');
	await page.getByRole('checkbox').check();
	await page.getByRole('button', { name: '保存并寻找突破点' }).click();
	await expect(page).toHaveURL(/\/cases\//);
	await expect(page.getByRole('heading', { name: '当前理解' })).toBeVisible();
	return page.url().match(/\/cases\/([^/?#]+)/)?.[1] ?? '';
}

async function submitFeedback(page: Page, shortcut: string, content: string, replacements = '') {
	await page.getByRole('button', { name: shortcut, exact: true }).click();
	await page.getByRole('textbox', { name: '补充情况' }).fill(content);
	if (replacements) {
		await page.getByText('替换姓名、单位或内部项目（可选）').click();
		await page.getByRole('textbox', { name: '敏感词替换' }).fill(replacements);
	}
	await page.getByLabel('我已检查预览，确认可以用于重新整理').check();
	await page.getByRole('button', { name: /保存.+重新整理/ }).click();
}

async function caseView(request: APIRequestContext, caseId: string) {
	const response = await request.get(`${BASE}/api/cases/${caseId}`);
	expect(response.ok()).toBe(true);
	return (await response.json()).data;
}

test('updates guidance after unreachable and already-asked feedback, then persists across refresh', async ({
	page,
	request
}) => {
	const caseId = await createGuidedCase(page, { title: '住宿沟通闭环' });
	await expect(page.getByRole('heading', { name: '值得核对的沟通疑点' })).toBeVisible();
	await expect(page.getByRole('heading', { name: '可以先试这一步' })).toHaveCount(1);

	await submitFeedback(
		page,
		'联系不上',
		'甲公司原对接人联系不上，我目前只能查看入职通知，备用电话是 13812345678。',
		'甲公司 => [单位]'
	);
	await expect(
		page.getByText('根据“联系不上”的补充，停止重复建议原联系人。').first()
	).toBeVisible();
	await submitFeedback(page, '我问过了', '我问过原对接人，但一直没有回复。');

	await expect(page.getByText('需要换一个可执行的突破点').first()).toBeVisible();
	await expect(page.getByText('寻找一个替代经办入口').first()).toBeVisible();
	const persisted = await caseView(request, caseId);
	expect(persisted.inputs).toHaveLength(2);
	expect(persisted.guidanceHistory).toHaveLength(3);

	await page.reload();
	await expect(page.getByText('需要换一个可执行的突破点').first()).toBeVisible();
	await expect(page.getByText('这是补充前的理解')).toHaveCount(0);
	await page.getByText('查看你的补充与回答（2）').click();
	await expect(page.getByText('[单位]原对接人联系不上')).toBeVisible();
	await expect(page.getByText('[手机号]')).toBeVisible();
	await expect(page.getByText('13812345678')).toHaveCount(0);

	const latestRun = [...persisted.events]
		.reverse()
		.find((event: { type: string }) => event.type === 'guidance.run.finished');
	expect(latestRun?.payload).toMatchObject({ modelCallCount: 1, searchCount: 0 });
});

test('answers a model question and receives the next guidance', async ({ page, request }) => {
	const caseId = await createGuidedCase(page, { title: '追问案例' });
	const firstView = await caseView(request, caseId);
	await expect(page.getByRole('heading', { name: '还需要你补充' })).toBeVisible();
	await expect(page.getByText('你已经向哪个入口问过，得到过什么回复？').first()).toBeVisible();

	await page
		.getByRole('textbox', { name: '补充情况' })
		.fill('我问过部门助理，对方让我等待人力通知。');
	await page.getByLabel('我已检查预览，确认可以用于重新整理').check();
	await page.getByRole('button', { name: '保存回答并重新整理' }).click();

	await expect(page.getByText('已把你的最新补充')).toBeVisible();
	await expect(page.getByRole('heading', { name: '还需要你补充' })).toHaveCount(0);
	const persisted = await caseView(request, caseId);
	expect(persisted.inputs).toHaveLength(1);
	expect(persisted.inputs[0]).toMatchObject({
		kind: 'context',
		guidanceId: firstView.guidance.id
	});
});

test('keeps feedback after a model failure and retries without duplicating it', async ({
	page,
	request
}) => {
	const caseId = await createGuidedCase(page, { title: '失败重试案例' });

	await submitFeedback(page, '有新回复', '请暂时失败：通知里仍然没有经办入口。');
	await expect(page.getByText('补充已保存，本轮未完成')).toBeVisible();
	let persisted = await caseView(request, caseId);
	expect(persisted.inputs).toHaveLength(1);
	expect(persisted.inputs[0].content).toContain('请暂时失败');

	await page.getByRole('button', { name: '只重试整理' }).click();
	await expect(page.getByText('已把你的最新补充')).toBeVisible();
	persisted = await caseView(request, caseId);
	expect(persisted.inputs).toHaveLength(1);
	expect(persisted.guidanceHistory).toHaveLength(2);
});

test('does not carry guidance state across client-side case navigation', async ({
	page,
	request
}) => {
	const createFirst = await request.post(`${BASE}/api/cases`, {
		data: {
			title: '第一个导航案例',
			goal: '推进第一件事',
			confusion: '不知道第一件事找谁。',
			evidence: [],
			replacements: []
		}
	});
	const firstId = (await createFirst.json()).data.case.id as string;
	const createSecond = await request.post(`${BASE}/api/cases`, {
		data: {
			title: '第二个导航案例',
			goal: '推进第二件事',
			confusion: '不知道第二件事找谁。',
			evidence: [
				{
					kind: 'message',
					content: '第二件事有独立的材料。',
					sourceLabel: '第二案例材料',
					occurredAt: null
				}
			],
			replacements: []
		}
	});
	const secondId = (await createSecond.json()).data.case.id as string;
	await request.post(`${BASE}/api/cases/${secondId}/guidance`);
	await page.goto(`${BASE}/cases/${firstId}`);
	await page.getByRole('textbox', { name: '补充情况' }).fill('只属于第一个案例的草稿');

	let releaseOldRequest = () => {};
	const oldRequestHeld = new Promise<void>((resolve) => (releaseOldRequest = resolve));
	let markIntercepted = () => {};
	const oldRequestIntercepted = new Promise<void>((resolve) => (markIntercepted = resolve));
	// 界面改为"启动 + 轮询"后，被扣住的是启动请求。
	await page.route(`**/api/cases/${firstId}/guidance/runs`, async (route) => {
		markIntercepted();
		await oldRequestHeld;
		await route.continue();
	});
	await page.getByRole('button', { name: '开始整理' }).click();
	await oldRequestIntercepted;

	await page.evaluate((href) => {
		const link = document.createElement('a');
		link.href = href;
		link.textContent = '打开第二案例';
		document.body.append(link);
	}, `${BASE}/cases/${secondId}`);
	await page.getByRole('link', { name: '打开第二案例' }).click();

	await expect(page).toHaveURL(new RegExp(`/cases/${secondId}$`));
	await expect(page.getByRole('heading', { name: '第二个导航案例' })).toBeVisible();
	await expect(page.getByText('推进第二件事', { exact: true })).toBeVisible();
	await expect(page.getByRole('textbox', { name: '补充情况' })).toHaveValue('');

	const oldResponse = page.waitForResponse(
		(response) =>
			response.url().includes(`/api/cases/${firstId}/guidance/runs`) && response.status() === 200
	);
	releaseOldRequest();
	await oldResponse;
	await expect(page.getByRole('heading', { name: '第二个导航案例' })).toBeVisible();
	await expect(page).toHaveURL(new RegExp(`/cases/${secondId}$`));
});

test('changing a redaction preview invalidates confirmation', async ({ page }) => {
	await page.goto(`${BASE}/cases/new`);
	await page.getByLabel('给这件事起个短标题').fill('预览失效案例');
	await page.getByLabel('你最终想做到什么？').fill('确认预览与提交内容一致');
	await page.getByLabel('现在最让你困惑的地方').fill('需要修改内容后重新检查。');
	const confirmation = page.getByLabel('我已检查预览，确认可以用这些内容帮助梳理。');
	await confirmation.check();
	await expect(page.getByRole('button', { name: '保存并寻找突破点' })).toBeEnabled();

	await page.getByLabel('现在最让你困惑的地方').fill('修改后的内容必须重新检查。');
	await expect(confirmation).not.toBeChecked();
	await expect(page.getByRole('button', { name: '保存并寻找突破点' })).toBeDisabled();
});

test('changing feedback or material invalidates its own preview confirmation', async ({
	page,
	request
}) => {
	const response = await request.post(`${BASE}/api/cases`, {
		data: {
			title: '补充预览失效案例',
			goal: '检查补充预览',
			confusion: '修改内容后需要重新确认。',
			evidence: [],
			replacements: []
		}
	});
	const caseId = (await response.json()).data.case.id as string;
	await page.goto(`${BASE}/cases/${caseId}`);
	const feedback = page.getByRole('textbox', { name: '补充情况' });
	await feedback.fill('原对接人电话是 13812345678。');
	const feedbackConfirmation = page.getByLabel('我已检查预览，确认可以用于重新整理');
	await feedbackConfirmation.check();
	await feedback.fill('原对接人电话改为 13912345678。');
	await expect(feedbackConfirmation).not.toBeChecked();

	await page.getByText('原材料与补充').click();
	const material = page.getByRole('textbox', { name: '原材料内容' });
	await material.fill('通知发到了 first@example.com。');
	const materialConfirmation = page.getByLabel('我已检查预览，确认可以用于重新整理').last();
	await materialConfirmation.check();
	await material.fill('通知改发到 second@example.com。');
	await expect(materialConfirmation).not.toBeChecked();
	await expect(page.getByRole('button', { name: '保存材料并重新整理' })).toBeDisabled();
});

test('guided entry copy describes provisional understanding and a breakthrough step', async ({
	page
}) => {
	await page.goto(`${BASE}/`);
	await expect(page.getByRole('heading', { name: '先形成一版理解，再试一个下一步' })).toBeVisible();
	await expect(page.getByText('建议始终可以补充，也可以纠正')).toBeVisible();
	await page.getByRole('link', { name: '新建一件卡住的事' }).click();
	await expect(page.getByText('先形成一版暂时理解，再找一个可以试的突破点')).toBeVisible();
});

test('keeps running and failure status visible while reading a long case on mobile', async ({
	page
}) => {
	// Use a distinct client identity so earlier tests do not consume this user's IP quota.
	await page.setExtraHTTPHeaders({ 'x-forwarded-for': '192.0.2.249' });
	await page.setViewportSize({ width: 390, height: 844 });
	const caseId = await createGuidedCase(page, { title: '运行状态可见性' });
	let finish = false;
	await page.route(`**/api/cases/${caseId}/guidance/runs/*`, async (route) => {
		if (finish) {
			await route.fulfill({
				status: 503,
				json: { ok: false, error: { message: '连接暂时中断，请重试。' } }
			});
		} else {
			await route.fulfill({
				json: { ok: true, data: { phase: 'thinking', elapsedMs: 25000, done: false } }
			});
		}
	});
	await submitFeedback(page, '联系不上', '原联系人一直没有回复。');
	const status = page.getByRole('region', { name: '运行状态' });
	await expect(status).toContainText('正在理解你的材料');
	await expect(status).toContainText('已用 25 秒');
	await page.getByRole('heading', { name: '整理记录' }).scrollIntoViewIfNeeded();
	await expect(status).toBeInViewport();
	await page.screenshot({ path: '/tmp/background-board-run-status-mobile.png' });
	finish = true;
	await expect(status).toContainText('补充已保存，本轮未完成');
	await expect(status.getByRole('button', { name: '只重试整理' })).toBeVisible();
	await expect(status).not.toContainText('本轮整理已完成');
	const dimensions = await page.evaluate(() => ({
		width: innerWidth,
		content: document.documentElement.scrollWidth
	}));
	expect(dimensions.content).toBeLessThanOrEqual(dimensions.width);
});

test('supersedes an in-flight run when newer input arrives and keeps the newest guidance', async ({
	page,
	request
}) => {
	const caseId = await createGuidedCase(page, { title: '慢速替代案例' });

	// 提交第一版补充：慢速夹具让这一轮保持在飞。
	await submitFeedback(page, '有新回复', '第一版补充，这一轮稍后会被替代。');
	// 等到首次轮询显示出“正在理解”：此刻旧运行确实已经启动且在飞行中。
	await expect(page.getByText('正在理解你的材料')).toBeVisible({ timeout: 20_000 });

	// 新输入提升 contextRevision：服务端应取消旧运行并启动新一轮。
	const newerInput = await request.post(`${BASE}/api/cases/${caseId}/inputs`, {
		data: {
			kind: 'context',
			content: '第二版补充：请以这一版为准。',
			guidanceId: null,
			requestId: randomUUID(),
			replacements: []
		}
	});
	expect(newerInput.ok()).toBe(true);
	await request.post(`${BASE}/api/cases/${caseId}/guidance/runs`);

	// 旧运行以 superseded 结束，界面明确显示“已由更新后的整理替代”。
	await expect(page.getByText('已由更新后的整理替代')).toBeVisible({ timeout: 20_000 });

	// 新一轮以最新补充完成；旧结果不能成为当前理解。
	await expect(async () => {
		const view = await caseView(request, caseId);
		expect(view.guidance?.draft.understanding.summary ?? '').toContain('第二版补充');
	}).toPass({ timeout: 30_000 });
	await page.reload();
	await expect(
		page.getByText('已把你的最新补充“第二版补充：请以这一版为准。”').first()
	).toBeVisible();
	const persisted = await caseView(request, caseId);
	const outcomes = persisted.events
		.filter((event: { type: string }) => event.type === 'guidance.run.finished')
		.map((event: { payload: { outcome: string } }) => event.payload.outcome);
	expect(outcomes.at(-2)).toBe('superseded');
	expect(outcomes.at(-1)).toBe('ready');
});

test('reports unavailable search clearly and still finishes guidance without leaking raw JSON', async ({
	page,
	request
}) => {
	const caseId = await createGuidedCase(page, { title: '搜索失败案例' });
	const persisted = await caseView(request, caseId);
	const finished = persisted.events.find(
		(event: { type: string }) => event.type === 'guidance.run.finished'
	);
	const searches = (finished?.payload as { searches?: Array<{ outcome: string }> }).searches ?? [];
	expect(searches).toHaveLength(1);
	expect(searches[0].outcome).toBe('unavailable');
	// 指导仍然完成，并且正文没有把原始 JSON 泄漏到界面。
	await expect(page.getByText('先围绕').first()).toBeVisible();
	await expect(page.getByText('{"type":"provide_guidance"')).toHaveCount(0);
});

test('keeps an invalid source reference out of the final guidance', async ({ page }) => {
	// “非法来源”夹具会引用不存在的来源 id：引用校验必须拦下它。
	const caseId = await createGuidedCase(page, { title: '非法来源案例' });
	await expect(page.getByRole('heading', { name: '当前理解' })).toBeVisible();
	const response = await page.request.get(`${BASE}/api/cases/${caseId}`);
	expect(response.ok()).toBe(true);
	const view = (await response.json()).data;
	expect(view.guidance).not.toBeNull();
	const sources = view.guidance.draft.understanding.sources as Array<{ id: string }>;
	expect(sources.some((source) => source.id === 'evidence-not-exist')).toBe(false);
});
