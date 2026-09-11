import { readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PREFIX = 'background-board-e2e-';

/**
 * 删除本轮端到端测试使用的临时数据目录。
 *
 * 只在系统临时目录里按固定前缀匹配，不触碰其它路径；这样即使 teardown
 * 拿不到配置进程的环境变量，也不会留下残留。
 */
export default function globalTeardown(): void {
	const explicit = process.env.BACKGROUND_BOARD_E2E_DATA_DIR;
	const targets = new Set<string>();
	if (explicit) targets.add(explicit);
	try {
		for (const entry of readdirSync(tmpdir())) {
			if (entry.startsWith(PREFIX)) targets.add(join(tmpdir(), entry));
		}
	} catch {
		// 临时目录不可读时只依赖显式路径，不影响测试结论。
	}
	for (const target of targets) {
		if (!target.includes(PREFIX)) continue;
		rmSync(target, { recursive: true, force: true });
	}
}
