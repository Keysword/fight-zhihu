import { dormDemoBoard, dormDemoEvidence } from '$lib/domain/demo-case';
import type { BackgroundBoard, CaseRecord } from '$lib/domain/types';

export function buildDormDemoFallback(caseRecord: CaseRecord): BackgroundBoard | null {
	const idMap = new Map<string, string>();
	for (const fixture of dormDemoEvidence) {
		const actual = caseRecord.evidence.find(
			(evidence) =>
				evidence.sourceLabel === fixture.sourceLabel && evidence.content === fixture.content
		);
		if (!actual) return null;
		idMap.set(fixture.id, actual.id);
	}

	const board = structuredClone(dormDemoBoard);
	const mapIds = (ids: string[]) => ids.map((id) => idMap.get(id) ?? id);
	board.caseId = caseRecord.id;
	board.title = caseRecord.title;
	board.goal = caseRecord.goal;
	board.updatedAt = new Date().toISOString();
	for (const claim of board.claims) claim.evidenceIds = mapIds(claim.evidenceIds);
	for (const participant of board.participants)
		participant.evidenceIds = mapIds(participant.evidenceIds);
	if (board.keyCompleter) board.keyCompleter.evidenceIds = mapIds(board.keyCompleter.evidenceIds);
	return board;
}
