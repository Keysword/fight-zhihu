import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './tests',
	testMatch: '**/*.spec.ts',
	workers: 1,
	expect: { timeout: 15_000 },
	globalSetup: './tests/global-setup.ts',
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
		},
		{
			// SDK 直连 + SSE 流式：同一套 guided 回归在 SDK 传输组合下再跑一遍。
			name: 'guided-sdk',
			testMatch: /guidance\.spec\.ts/,
			use: { baseURL: 'http://127.0.0.1:4175' }
		}
	]
});
