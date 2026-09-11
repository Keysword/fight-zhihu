import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from '@playwright/test';

/**
 * 浏览器测试必须使用独立的临时数据目录，绝不继承生产或个人开发数据目录。
 *
 * 这份配置会在多个进程里被求值（运行器与各 worker），因此创建目录必须幂等：
 * 已有环境变量就复用，避免一次运行产生多个目录、只删掉其中一个。
 * 轮次结束后，确切路径经 metadata 交给 globalTeardown 精确删除——不用环境变量
 * 传路径给 teardown（实测 teardown 进程里该变量为空），也不按前缀扫描删除
 * （并行跑多个测试任务时，扫描会删掉另一个进程仍在使用的数据库）。
 */
const dataDirectory =
	process.env.BACKGROUND_BOARD_E2E_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'background-board-e2e-'));
process.env.BACKGROUND_BOARD_E2E_DATA_DIR = dataDirectory;

export default defineConfig({
	testDir: './tests',
	testMatch: '**/*.spec.ts',
	globalTeardown: './tests/global-teardown.ts',
	metadata: { e2eDataDirectory: dataDirectory },
	use: { baseURL: 'http://127.0.0.1:4173' },
	webServer: {
		command: 'pnpm build && pnpm preview -- --host 127.0.0.1',
		port: 4173,
		env: { BACKGROUND_BOARD_DATA_DIR: dataDirectory }
	}
});
