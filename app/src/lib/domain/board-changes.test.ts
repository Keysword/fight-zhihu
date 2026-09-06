import { describe, expect, it } from 'vitest';

import { dormDemoBoard } from './demo-case';
import { diffBoards } from './board-changes';

describe('board changes', () => {
	it('identifies changed claims, blocker and next action without treating timestamps as content', () => {
		const previous = structuredClone(dormDemoBoard);
		const next = structuredClone(dormDemoBoard);
		next.updatedAt = '2026-09-06T00:00:00.000Z';
		next.currentBlocker = '新的阻塞点';
		next.claims[0].text = '新的结论';
		next.nextAction!.question = '新的关键问题';

		expect(diffBoards(previous, next)).toEqual({
			blocker: true,
			claimIds: ['claim-eligibility'],
			removedClaimCount: 0,
			nextAction: true,
			stage: false,
			keyCompleter: false,
			participants: false,
			externalClues: false
		});
	});

	it('reports removed claims and structural board changes', () => {
		const previous = structuredClone(dormDemoBoard);
		const next = structuredClone(dormDemoBoard);
		next.claims.pop();
		next.participants.pop();
		next.keyCompleter = null;
		next.externalClues = [];
		next.stage = 'resolved';
		const result = diffBoards(previous, next);
		expect(result).toMatchObject({
			removedClaimCount: 1,
			participants: true,
			keyCompleter: true,
			externalClues: true,
			stage: true
		});
	});
});
