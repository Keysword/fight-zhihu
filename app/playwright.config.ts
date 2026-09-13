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
		}
	]
});
