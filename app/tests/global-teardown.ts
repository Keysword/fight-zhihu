import { rmSync } from 'node:fs';

import type { FullConfig } from '@playwright/test';

const PREFIX = 'background-board-e2e-';

/**
 * 只删除本轮创建的确切数据目录。
 *
 * 路径由 playwright.config.ts 放进 metadata，而不是按前缀扫描临时目录：
 * 并行运行多个端到端任务时，扫描会把另一个进程仍在使用的数据库一起删掉。
 * 也不用环境变量向 teardown 传路径——实测 teardown 进程里该变量为空。
 */
export default function globalTeardown(config: FullConfig): void {
	const directory = (config.metadata as { e2eDataDirectory?: string }).e2eDataDirectory;
	// 双重保险：只接受自己创建的那类路径，避免配置被改动后误删其它目录。
	if (!directory || !directory.includes(PREFIX)) return;
	rmSync(directory, { recursive: true, force: true });
}
