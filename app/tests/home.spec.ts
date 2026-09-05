import { expect, test } from '@playwright/test';

test('introduces the product and its two starting paths', async ({ page }) => {
	await page.goto('/background-board/');
	await expect(page.getByRole('heading', { name: '先把背景拼完整，再决定下一步' })).toBeVisible();
	await expect(page.getByRole('button', { name: '体验宿舍案例' })).toBeVisible();
	await expect(page.getByRole('link', { name: '新建一件卡住的事' })).toBeVisible();
});
