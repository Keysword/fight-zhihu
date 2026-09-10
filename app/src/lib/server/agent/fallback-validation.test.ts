import { describe, expect, it } from 'vitest';

import type { Evidence } from '$lib/domain/types';
import { buildDormDemoFallback } from './fallback';
import { validateBoardForCase } from './tools';

/**
 * 复刻生产库中的宿舍演示案例形态：全部证据都是聊天记录（message），
 * 没有正式通知（notice）。用户后来补充的物业回复同样是一条聊天记录。
 * 这是 README 推荐的主演示闭环路径。
 */
function evidence(
	id: string,
	kind: Evidence['kind'],
	content: string,
	sourceLabel: string
): Evidence {
	return { id, kind, content, sourceLabel, occurredAt: null, confirmation: 'self_reported' };
}

function caseRecord(items: Evidence[]) {
	return {
		id: 'case-demo',
		title: '新人入住宿舍',
		goal: '确认 8 月 2 日到达后是否可以实际入住',
		confusion: '不知道是否已分房以及钥匙由谁交付',
		stage: 'collecting' as const,
		revision: 1,
		createdAt: '2026-09-05T00:00:00.000Z',
		updatedAt: '2026-09-05T00:00:00.000Z',
		board: null,
		evidence: items
	};
}

const baseEvidence = [
	evidence(
		'e1',
		'message',
		'部门对接人：应该可以提前入住，我先申请。之后会有同事联系你，在门口接你。',
		'部门对接人'
	),
	evidence(
		'e2',
		'message',
		'接引同事：我可以带你进入园区，但我们看不到住宿分配结果，需要问物业。',
		'接引同事'
	),
	evidence('e3', 'message', '人力：住宿结果以正式邮件通知为准。', '人力老师'),
	evidence(
		'e4',
		'note',
		'我计划在 8 月 2 日 16:00 到达，但目前没有收到房间号，也不知道钥匙由谁交付。',
		'我的补充'
	)
];

const propertyReply = evidence(
	'e5',
	'message',
	'物业刚回复：房间已经分配，钥匙在前台领取。',
	'物业'
);

describe('dorm demo fallback against production-shaped data', () => {
	it('passes validation before the user adds the property reply', () => {
		const record = caseRecord(baseEvidence);
		const board = buildDormDemoFallback(record);
		expect(board).not.toBeNull();
		expect(() => validateBoardForCase(board!, record, board!.externalClues)).not.toThrow();
	});

	it('passes validation after the user adds the property reply', () => {
		const record = caseRecord([...baseEvidence, propertyReply]);
		const board = buildDormDemoFallback(record);
		expect(board).not.toBeNull();
		// 这一步会让板从 waiting 进入 actionable，是主演示的收尾。
		expect(board!.stage).toBe('actionable');
		expect(() => validateBoardForCase(board!, record, board!.externalClues)).not.toThrow();
	});
});
