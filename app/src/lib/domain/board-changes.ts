import type { BackgroundBoard } from './types';

export interface BoardChanges {
	blocker: boolean;
	claimIds: string[];
	nextAction: boolean;
}

function sameValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export function diffBoards(
	previous: BackgroundBoard | null,
	next: BackgroundBoard | null
): BoardChanges {
	if (!previous || !next) {
		return {
			blocker: previous?.currentBlocker !== next?.currentBlocker,
			claimIds: next?.claims.map((claim) => claim.id) ?? [],
			nextAction: !sameValue(previous?.nextAction, next?.nextAction)
		};
	}

	const previousClaims = new Map(previous.claims.map((claim) => [claim.id, claim]));
	return {
		blocker: previous.currentBlocker !== next.currentBlocker,
		claimIds: next.claims
			.filter((claim) => !sameValue(previousClaims.get(claim.id), claim))
			.map((claim) => claim.id),
		nextAction: !sameValue(previous.nextAction, next.nextAction)
	};
}
