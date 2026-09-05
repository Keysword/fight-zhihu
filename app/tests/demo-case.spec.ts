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
	await expect(page.getByText('部门对接人：应该可以提前入住')).toBeVisible();
	await expect(page.getByRole('button', { name: '复制这段话' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Agent 动态' })).toBeVisible();
	await page.getByLabel('补充证据').fill('物业刚回复：房间已经分配，钥匙在前台领取。');
	await page.getByRole('button', { name: '加入证据并继续判断' }).click();
	await expect(page.getByText('第 2 次整理')).toBeVisible();
});
