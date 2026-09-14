import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const READY_DEADLINE_MS = 120_000;
const STOP_DEADLINE_MS = 5_000;
const OWNERSHIP_MARKER = '.background-board-e2e-owner';
const RUN_DIRECTORY_PATTERN = /^background-board-e2e-[A-Za-z0-9]+$/;

const isolatedEnvironment = {
	AGENT_API_URL: '',
	AGENT_API_KEY: '',
	AGENT_MODEL: '',
	AGENT_TRANSPORT: '',
	AGENT_SDK_BASE_URL: '',
	AGENT_SDK_STREAM: '',
	OPENCODE_SERVER_USERNAME: '',
	OPENCODE_SERVER_PASSWORD: '',
	OPENCODE_SERVER_URL: '',
	ZHIHU_ACCESS_SECRET: ''
};

function childEnvironment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
	return { ...process.env, ...isolatedEnvironment, ...overrides };
}

function run(command: string, args: string[], environment = childEnvironment()): ChildProcess {
	return spawn(command, args, {
		cwd: process.cwd(),
		env: environment,
		stdio: 'inherit'
	});
}

async function waitForExit(child: ChildProcess): Promise<number | null> {
	if (child.exitCode !== null) return child.exitCode;
	return new Promise((resolve) => child.once('exit', resolve));
}

async function buildApplication(): Promise<void> {
	const build = run('pnpm', ['build']);
	const code = await waitForExit(build);
	if (code !== 0) throw new Error(`production build failed with exit code ${code}`);
}

async function waitUntilReady(child: ChildProcess, url: string): Promise<void> {
	const deadline = Date.now() + READY_DEADLINE_MS;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`test process exited before ${url} became ready (code ${child.exitCode})`);
		}
		try {
			const response = await fetch(url);
			if (response.ok) {
				// Avoid accepting a different process that was already listening on the fixed port.
				await new Promise((resolve) => setTimeout(resolve, 100));
				if (child.exitCode === null) return;
			}
		} catch {
			// The child is still starting.
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`timed out waiting for ${url}`);
}

async function stop(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null) return;
	child.kill('SIGTERM');
	const exited = waitForExit(child).then(() => true);
	let timeout: NodeJS.Timeout;
	const timedOut = new Promise<false>((resolve) => {
		timeout = setTimeout(() => resolve(false), STOP_DEADLINE_MS);
	});
	const exitedInTime = await Promise.race([exited, timedOut]);
	clearTimeout(timeout!);
	if (exitedInTime) return;
	child.kill('SIGKILL');
	await waitForExit(child);
}

function removeOwnedRunDirectory(directory: string, ownershipToken: string): void {
	const stats = lstatSync(directory);
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new Error('refusing to remove a non-directory or symbolic-link E2E path');
	}
	const canonicalDirectory = realpathSync(directory);
	const canonicalTemporaryDirectory = realpathSync(tmpdir());
	if (
		dirname(canonicalDirectory) !== canonicalTemporaryDirectory ||
		!RUN_DIRECTORY_PATTERN.test(basename(canonicalDirectory))
	) {
		throw new Error(`refusing to remove unexpected E2E path: ${canonicalDirectory}`);
	}
	const marker = readFileSync(join(canonicalDirectory, OWNERSHIP_MARKER), 'utf8');
	if (marker !== ownershipToken) {
		throw new Error(
			`refusing to remove E2E path without its ownership marker: ${canonicalDirectory}`
		);
	}
	rmSync(canonicalDirectory, { recursive: true, force: true });
}

export default async function globalSetup(): Promise<() => Promise<void>> {
	const runDirectory = mkdtempSync(join(tmpdir(), 'background-board-e2e-'));
	const ownershipToken = randomUUID();
	writeFileSync(join(runDirectory, OWNERSHIP_MARKER), ownershipToken, { flag: 'wx' });
	const legacyDataDirectory = join(runDirectory, 'legacy');
	const guidedDataDirectory = join(runDirectory, 'guided');
	const guidedSdkDataDirectory = join(runDirectory, 'guided-sdk');
	mkdirSync(legacyDataDirectory);
	mkdirSync(guidedDataDirectory);
	mkdirSync(guidedSdkDataDirectory);

	const children: ChildProcess[] = [];
	const cleanup = async () => {
		for (const child of children.reverse()) await stop(child);
		removeOwnedRunDirectory(runDirectory, ownershipToken);
	};

	try {
		await buildApplication();

		const model = run(process.execPath, ['tests/fixtures/guidance-model.mjs']);
		children.push(model);
		await waitUntilReady(model, 'http://127.0.0.1:4789/health');

		const legacy = run(
			process.execPath,
			['build/index.js'],
			childEnvironment({
				HOST: '127.0.0.1',
				PORT: '4173',
				ORIGIN: 'http://127.0.0.1:4173',
				BACKGROUND_BOARD_DATA_DIR: legacyDataDirectory,
				BACKGROUND_BOARD_GUIDANCE_V2: '0'
			})
		);
		children.push(legacy);
		await waitUntilReady(legacy, 'http://127.0.0.1:4173/background-board/api/health');

		const guided = run(
			process.execPath,
			['build/index.js'],
			childEnvironment({
				HOST: '127.0.0.1',
				PORT: '4174',
				ORIGIN: 'http://127.0.0.1:4174',
				AGENT_API_URL: 'http://127.0.0.1:4789/v1/chat/completions',
				AGENT_MODEL: 'scripted-guidance-e2e',
				BACKGROUND_BOARD_DATA_DIR: guidedDataDirectory,
				BACKGROUND_BOARD_GUIDANCE_V2: '1',
				GUIDANCE_RUN_RATE_LIMIT: '100'
			})
		);
		children.push(guided);
		await waitUntilReady(guided, 'http://127.0.0.1:4174/background-board/api/health');

		const guidedSdk = run(
			process.execPath,
			['build/index.js'],
			childEnvironment({
				HOST: '127.0.0.1',
				PORT: '4175',
				ORIGIN: 'http://127.0.0.1:4175',
				AGENT_TRANSPORT: 'sdk',
				AGENT_SDK_BASE_URL: 'http://127.0.0.1:4789/v1',
				AGENT_SDK_STREAM: '1',
				AGENT_API_KEY: 'scripted-e2e-key',
				AGENT_MODEL: 'scripted-guidance-e2e',
				BACKGROUND_BOARD_DATA_DIR: guidedSdkDataDirectory,
				BACKGROUND_BOARD_GUIDANCE_V2: '1',
				GUIDANCE_RUN_RATE_LIMIT: '100'
			})
		);
		children.push(guidedSdk);
		await waitUntilReady(guidedSdk, 'http://127.0.0.1:4175/background-board/api/health');
		return cleanup;
	} catch (error) {
		await cleanup();
		throw error;
	}
}
