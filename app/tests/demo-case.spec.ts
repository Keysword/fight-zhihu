import { expect, test } from '@playwright/test';

test('opens the dorm case as an evidence-linked background board', async ({ page }) => {
	await page.goto('/background-board/');
	await page.getByRole('button', { name: '体验宿舍案例' }).click();
	await expect(page).toHaveURL(/\/cases\//);
	await expect(
		page.getByRole('heading', { name: '房间是否分配、钥匙由谁交付仍未得到负责方确认' })
	).toBeVisible();
	await expect(page.getByText('人力 / 住宿管理方').first()).toBeVisible();
	await expect(
		page.getByText('人力负责正式通知，并且最有机会联系物业核实房间和钥匙状态')
	).toBeVisible();
	await expect(page.getByText('部门对接人：应该可以提前入住').first()).toBeVisible();
	const firstClaim = page.locator('.claim-slip').first();
	await firstClaim.getByText('查看 2 条原始证据').click();
	await expect(firstClaim.getByText('部门对接人', { exact: true })).toBeVisible();
	await expect(firstClaim.getByText('部门对接人：应该可以提前入住').first()).toBeVisible();
	await expect(page.getByRole('button', { name: '复制这段话' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Agent 动态' })).toBeVisible();
	await expect(page.locator('.clue a')).toHaveAttribute(
		'href',
		'https://www.zhihu.com/question/428152303/answer/1572634952'
	);
	await page.getByLabel('补充证据').fill('物业刚回复：房间已经分配，钥匙在前台领取。');
	await expect(page.getByText('本次外发预览')).toBeVisible();
	await page.getByText('我已检查这条新证据的脱敏预览').click();
	await page.getByRole('button', { name: '加入证据并继续判断' }).click();
	await expect(page.getByText('第 1 次整理')).toBeVisible();
	await expect(
		page.getByRole('heading', { name: '房间与钥匙位置已经补全，需要确认到达时间和前台领取细节' })
	).toBeVisible();
	await expect(page.getByLabel('待确认的背景板更新')).toBeVisible();
	await expect(page.locator('.blocker-banner')).toHaveClass(/changed/);
	await expect(page.locator('.claim-slip.changed')).toHaveCount(3);
	await expect(page.locator('.next-action')).toHaveClass(/changed/);
	await expect(page.getByText(/本次更新：.*阻塞点已变化/)).toBeVisible();
	await page.getByRole('button', { name: '确认并更新背景板' }).click();
	await expect(page.getByText('第 2 次整理')).toBeVisible();
	await expect(page.getByLabel('待确认的背景板更新')).toHaveCount(0);
});
