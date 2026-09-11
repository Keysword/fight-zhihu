import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from '@playwright/test';

/**
 * 浏览器测试必须使用独立的临时数据目录，绝不继承生产或个人开发数据目录。
 *
 * 配置加载时创建一个全新的空目录并写进 process.env：webServer 与测试进程
 * 都会继承它，因此整轮端到端测试只写这个目录。结束后由 globalTeardown 删除。
 */
const dataDirectory = mkdtempSync(join(tmpdir(), 'background-board-e2e-'));
process.env.BACKGROUND_BOARD_E2E_DATA_DIR = dataDirectory;
process.env.BACKGROUND_BOARD_DATA_DIR = dataDirectory;

export default defineConfig({
	testDir: './tests',
	testMatch: '**/*.spec.ts',
	globalTeardown: './tests/global-teardown.ts',
	use: { baseURL: 'http://127.0.0.1:4173' },
	webServer: {
		command: 'pnpm build && pnpm preview -- --host 127.0.0.1',
		port: 4173,
		env: { BACKGROUND_BOARD_DATA_DIR: dataDirectory }
	}
});
