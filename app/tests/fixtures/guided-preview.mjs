import { spawn } from 'node:child_process';

const LEGACY_HEALTH = 'http://127.0.0.1:4173/background-board/api/health';
const DEADLINE_MS = 120_000;
let preview;

async function waitForLegacyBuild() {
	const deadline = Date.now() + DEADLINE_MS;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(LEGACY_HEALTH);
			if (response.ok) return;
		} catch {
			// The legacy process is still building the shared production bundle.
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error('legacy preview did not become ready before guided preview startup');
}

async function main() {
	await waitForLegacyBuild();
	preview = spawn('pnpm', ['preview', '--', '--host', '127.0.0.1', '--port', '4174'], {
		stdio: 'inherit',
		env: process.env
	});
	preview.once('exit', (code) => process.exit(code ?? 0));
}

function shutdown(signal) {
	if (preview && !preview.killed) preview.kill(signal);
	else process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
