import type { BackgroundBoard } from './types';

export interface BoardChanges {
	blocker: boolean;
	claimIds: string[];
	removedClaimCount?: number;
	nextAction: boolean;
	stage?: boolean;
	keyCompleter?: boolean;
	participants?: boolean;
	externalClues?: boolean;
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
			removedClaimCount: previous?.claims.length ?? 0,
			nextAction: !sameValue(previous?.nextAction, next?.nextAction),
			stage: previous?.stage !== next?.stage,
			keyCompleter: !sameValue(previous?.keyCompleter, next?.keyCompleter),
			participants: !sameValue(previous?.participants, next?.participants),
			externalClues: !sameValue(previous?.externalClues, next?.externalClues)
		};
	}

	const previousClaims = new Map(previous.claims.map((claim) => [claim.id, claim]));
	const nextClaimIds = new Set(next.claims.map((claim) => claim.id));
	return {
		blocker: previous.currentBlocker !== next.currentBlocker,
		claimIds: next.claims
			.filter((claim) => !sameValue(previousClaims.get(claim.id), claim))
			.map((claim) => claim.id),
		removedClaimCount: previous.claims.filter((claim) => !nextClaimIds.has(claim.id)).length,
		nextAction: !sameValue(previous.nextAction, next.nextAction),
		stage: previous.stage !== next.stage,
		keyCompleter: !sameValue(previous.keyCompleter, next.keyCompleter),
		participants: !sameValue(previous.participants, next.participants),
		externalClues: !sameValue(previous.externalClues, next.externalClues)
	};
}
