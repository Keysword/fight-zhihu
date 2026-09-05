import { describe, expect, it } from 'vitest';
import { backgroundBoardSchema } from './schemas';
import { dormDemoBoard, dormDemoEvidence } from './demo-case';

describe('dorm demo', () => {
	it('is anonymous and separates the five easily confused states', () => {
		const board = backgroundBoardSchema.parse(dormDemoBoard);
		expect(dormDemoEvidence.map((evidence) => evidence.sourceLabel)).toEqual([
			'部门对接人',
			'接引同事',
			'人力老师',
			'我的补充'
		]);
		expect(board.participants.map((participant) => participant.name)).toEqual([
			'部门对接人',
			'接引同事',
			'人力 / 住宿管理方'
		]);
		expect(board.claims.map((claim) => claim.text).join('\n')).toMatch(/住宿资格/);
		expect(board.claims.map((claim) => claim.text).join('\n')).toMatch(/房间/);
		expect(board.claims.map((claim) => claim.text).join('\n')).toMatch(/进入园区/);
		expect(board.claims.map((claim) => claim.text).join('\n')).toMatch(/钥匙/);
		expect(board.claims.map((claim) => claim.text).join('\n')).toMatch(/正式通知/);
	});

	it('identifies a capable information completer without assigning intent', () => {
		expect(dormDemoBoard.keyCompleter?.participantId).toBe('participant-hr');
		expect(dormDemoBoard.keyCompleter?.rationale).toContain('联系物业');
		expect(JSON.stringify(dormDemoBoard)).not.toMatch(/故意|隐瞒|推卸/);
	});
});
