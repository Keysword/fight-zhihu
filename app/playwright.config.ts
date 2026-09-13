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
const legacyDataDirectory =
	process.env.BACKGROUND_BOARD_E2E_LEGACY_DATA_DIR ??
	mkdtempSync(join(tmpdir(), 'background-board-e2e-legacy-'));
const guidedDataDirectory =
	process.env.BACKGROUND_BOARD_E2E_GUIDED_DATA_DIR ??
	mkdtempSync(join(tmpdir(), 'background-board-e2e-guided-'));
process.env.BACKGROUND_BOARD_E2E_LEGACY_DATA_DIR = legacyDataDirectory;
process.env.BACKGROUND_BOARD_E2E_GUIDED_DATA_DIR = guidedDataDirectory;

const isolatedEnvironment = {
	AGENT_API_URL: '',
	AGENT_API_KEY: '',
	AGENT_MODEL: '',
	OPENCODE_SERVER_USERNAME: '',
	OPENCODE_SERVER_PASSWORD: '',
	OPENCODE_SERVER_URL: '',
	ZHIHU_ACCESS_SECRET: ''
};

export default defineConfig({
	testDir: './tests',
	testMatch: '**/*.spec.ts',
	workers: 1,
	expect: { timeout: 15_000 },
	globalTeardown: './tests/global-teardown.ts',
	metadata: { e2eDataDirectories: [legacyDataDirectory, guidedDataDirectory] },
	projects: [
		{
			name: 'legacy',
			testIgnore: /guidance\.spec\.ts/,
			use: { baseURL: 'http://127.0.0.1:4173' }
		},
		{
			name: 'guided',
			testMatch: /guidance\.spec\.ts/,
			use: { baseURL: 'http://127.0.0.1:4174' }
		}
	],
	webServer: [
		{
			command: 'exec node tests/fixtures/guidance-model.mjs',
			port: 4789,
			env: isolatedEnvironment
		},
		{
			command: 'pnpm build && pnpm preview -- --host 127.0.0.1 --port 4173',
			port: 4173,
			env: {
				...isolatedEnvironment,
				BACKGROUND_BOARD_DATA_DIR: legacyDataDirectory,
				BACKGROUND_BOARD_GUIDANCE_V2: '0'
			}
		},
		{
			command: 'node tests/fixtures/guided-preview.mjs',
			port: 4174,
			env: {
				...isolatedEnvironment,
				AGENT_API_URL: 'http://127.0.0.1:4789/v1/chat/completions',
				AGENT_MODEL: 'scripted-guidance-e2e',
				BACKGROUND_BOARD_DATA_DIR: guidedDataDirectory,
				BACKGROUND_BOARD_GUIDANCE_V2: '1'
			}
		}
	]
});
