import { expect, test } from '@playwright/test';

test('previews redaction and preserves a case when the model is unavailable', async ({ page }) => {
	await page.goto('/background-board/cases/new');
	await page.getByLabel('给这件事起个短标题').fill('入职电脑领取');
	await page.getByLabel('你最终想做到什么？').fill('确认周一能领到电脑');
	await page.getByLabel('现在最让你困惑的地方').fill('同事让我拨打 13812345678，但没说找谁');
	await page.getByLabel('先放一条证据（可选）').fill('通知发到了 new.hire@example.com');
	await expect(page.locator('.preview-box')).toContainText('[手机号]');
	await expect(page.locator('.preview-box')).toContainText('[邮箱]');
	await expect(page.locator('.preview-box')).not.toContainText('13812345678');
	await page.getByRole('checkbox').check();
	await page.getByRole('button', { name: '建立背景板并开始判断' }).click();
	await expect(page).toHaveURL(/\/cases\//);
	await expect(page.getByRole('heading', { name: '证据已经收好，背景板还没有形成' })).toBeVisible();
	await page.getByRole('button', { name: '让 Agent 开始判断' }).click();
	await expect(page.getByRole('alert')).toContainText('尚未配置可用的 Agent 模型');
});
