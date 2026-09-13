import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

import {
	caseInputSchema,
	droppedGuidanceFieldSchema,
	guidanceCompletenessSchema,
	guidanceDraftSchema
} from '$lib/domain/guidance';
import type {
	CaseInput,
	DroppedGuidanceField,
	GuidanceCompleteness,
	GuidanceDraft,
	GuidanceSnapshot,
	SourceRef
} from '$lib/domain/guidance';
import { backgroundBoardSchema, evidenceSchema, externalClueSchema } from '$lib/domain/schemas';
import type {
	AgentEvent,
	BackgroundBoard,
	CaseRecord,
	CaseStage,
	CaseSummary,
	Evidence
} from '$lib/domain/types';
import type { ExternalClue } from '$lib/domain/types';
import { openDatabase } from '$lib/server/db';

const newCaseSchema = z
	.object({
		title: z.string().trim().min(1).max(120),
		goal: z.string().trim().min(1).max(500),
		confusion: z.string().trim().min(1).max(5_000)
	})
	.strict();

const newEvidenceSchema = evidenceSchema.omit({ id: true });

interface CaseRow {
	id: string;
	title: string;
	goal: string;
	confusion: string;
	stage: CaseStage;
	revision: number;
	board_json: string | null;
	pending_board_json: string | null;
	pending_revision: number | null;
	context_revision: number;
	current_guidance_id: string | null;
	created_at: string;
	updated_at: string;
}

interface EvidenceRow {
	id: string;
	kind: Evidence['kind'];
	content: string;
	source_label: string;
	occurred_at: string | null;
	confirmation: Evidence['confirmation'];
}

interface EventRow {
	id: string;
	case_id: string;
	type: string;
	payload_json: string;
	created_at: string;
}

interface CaseInputRow {
	id: string;
	case_id: string;
	request_id: string;
	kind: CaseInput['kind'];
	content: string;
	guidance_id: string | null;
	context_revision: number;
	created_at: string;
}

interface GuidanceRow {
	id: string;
	case_id: string;
	run_id: string;
	context_revision: number;
	draft_json: string;
	external_clues_json: string;
	created_at: string;
	completeness: string | null;
	dropped_json: string | null;
}

const GUIDANCE_COLUMNS =
	'id, case_id, run_id, context_revision, draft_json, external_clues_json, created_at, completeness, dropped_json';

export class RevisionConflictError extends Error {
	constructor() {
		super('案例已被其他分析更新，请基于最新版本重试');
		this.name = 'RevisionConflictError';
	}
}

export class CaseNotFoundError extends Error {
	constructor(caseId: string) {
		super(`找不到案例：${caseId}`);
		this.name = 'CaseNotFoundError';
	}
}

export class EvidenceNotFoundError extends Error {
	constructor(evidenceId: string) {
		super(`找不到证据：${evidenceId}`);
		this.name = 'EvidenceNotFoundError';
	}
}

export class IdempotencyConflictError extends Error {
	constructor(requestId: string) {
		super(`请求 ${requestId} 已用于不同的输入`);
		this.name = 'IdempotencyConflictError';
	}
}

export class GuidanceRunConflictError extends Error {
	constructor(runId: string) {
		super(`Guidance 运行 ${runId} 已用于不同的快照`);
		this.name = 'GuidanceRunConflictError';
	}
}

export class GuidanceReferenceError extends Error {
	constructor() {
		super('指导引用无效或不属于当前案例');
		this.name = 'GuidanceReferenceError';
	}
}

function guidanceReferences(draft: GuidanceDraft): SourceRef[] {
	return [
		...draft.understanding.sources,
		...draft.communicationChecks.flatMap((check) => check.sources),
		...(draft.nextStep?.contact?.sources ?? [])
	];
}

function validateGuidanceReferences(
	database: DatabaseSync,
	caseId: string,
	draft: GuidanceDraft,
	externalClues: ExternalClue[]
): void {
	const externalIds = new Set<string>();
	for (const clue of externalClues) {
		if (externalIds.has(clue.id)) throw new GuidanceReferenceError();
		externalIds.add(clue.id);
	}

	const evidenceIds = new Set(
		(
			database
				.prepare('SELECT id FROM evidence WHERE case_id = ?')
				.all(caseId) as unknown as Array<{
				id: string;
			}>
		).map((row) => row.id)
	);
	const inputIds = new Set(
		(
			database
				.prepare('SELECT id FROM case_inputs WHERE case_id = ?')
				.all(caseId) as unknown as Array<{ id: string }>
		).map((row) => row.id)
	);

	for (const source of guidanceReferences(draft)) {
		const valid =
			source.kind === 'evidence'
				? evidenceIds.has(source.id)
				: source.kind === 'input'
					? inputIds.has(source.id)
					: externalIds.has(source.id);
		if (!valid) throw new GuidanceReferenceError();
	}
}

function summaryFromRow(row: CaseRow): CaseSummary {
	return {
		id: row.id,
		title: row.title,
		goal: row.goal,
		confusion: row.confusion,
		stage: row.stage,
		revision: row.revision,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function evidenceFromRow(row: EvidenceRow): Evidence {
	return evidenceSchema.parse({
		id: row.id,
		kind: row.kind,
		content: row.content,
		sourceLabel: row.source_label,
		occurredAt: row.occurred_at,
		confirmation: row.confirmation
	});
}

function caseInputFromRow(row: CaseInputRow): CaseInput {
	const request = caseInputSchema.parse({
		requestId: row.request_id,
		kind: row.kind,
		content: row.content,
		guidanceId: row.guidance_id
	});
	return {
		...request,
		id: row.id,
		caseId: row.case_id,
		contextRevision: row.context_revision,
		createdAt: row.created_at
	};
}

function guidanceFromRow(row: GuidanceRow): GuidanceSnapshot {
	return {
		id: row.id,
		caseId: row.case_id,
		runId: row.run_id,
		contextRevision: row.context_revision,
		createdAt: row.created_at,
		draft: guidanceDraftSchema.parse(JSON.parse(row.draft_json)),
		externalClues: z.array(externalClueSchema).parse(JSON.parse(row.external_clues_json)),
		// Rows written before the degradation columns existed are complete by definition.
		completeness: guidanceCompletenessSchema.catch('full').parse(row.completeness ?? 'full'),
		dropped: z
			.array(droppedGuidanceFieldSchema)
			.catch([])
			.parse(JSON.parse(row.dropped_json ?? '[]'))
	};
}

export interface CaseRepository {
	createCase(input: z.input<typeof newCaseSchema>): CaseRecord;
	listCases(): CaseSummary[];
	getCase(caseId: string): CaseRecord | null;
	appendEvidence(caseId: string, input: z.input<typeof newEvidenceSchema>): Evidence;
	appendCaseInput(
		caseId: string,
		input: z.input<typeof caseInputSchema>
	): {
		outcome: 'inserted' | 'replayed';
		input: CaseInput;
		currentContextRevision: number;
	};
	listCaseInputs(caseId: string): CaseInput[];
	getCaseContext(caseId: string): {
		contextRevision: number;
		currentGuidanceId: string | null;
	};
	saveGuidance(
		caseId: string,
		expectedContextRevision: number,
		draft: GuidanceDraft,
		externalClues: ExternalClue[],
		runId: string,
		degradation?: { completeness: GuidanceCompleteness; dropped: DroppedGuidanceField[] }
	): {
		status: 'current' | 'superseded';
		snapshot: GuidanceSnapshot;
		currentContextRevision: number;
		currentGuidanceId: string | null;
	};
	getCurrentGuidance(caseId: string): GuidanceSnapshot | null;
	getGuidance(caseId: string, guidanceId: string): GuidanceSnapshot | null;
	listGuidance(caseId: string, limit?: number): GuidanceSnapshot[];
	saveBoard(caseId: string, expectedRevision: number, board: BackgroundBoard): CaseRecord;
	confirmEvidence(caseId: string, evidenceId: string): Evidence;
	stageBoardProposal(caseId: string, expectedRevision: number, board: BackgroundBoard): CaseRecord;
	confirmBoardProposal(caseId: string, expectedRevision: number): CaseRecord;
	discardBoardProposal(caseId: string, expectedRevision: number): CaseRecord;
	appendEvent(
		caseId: string,
		event: { type: string; payload: Record<string, unknown> }
	): AgentEvent;
	listEvents(caseId: string): AgentEvent[];
	close(): void;
}

export function createCaseRepository(path: string): CaseRepository {
	const database = openDatabase(path);

	function requireCase(caseId: string): CaseRow {
		const row = database.prepare('SELECT * FROM cases WHERE id = ?').get(caseId) as
			CaseRow | undefined;
		if (!row) throw new CaseNotFoundError(caseId);
		return row;
	}

	function getEvidence(caseId: string): Evidence[] {
		const rows = database
			.prepare(
				'SELECT id, kind, content, source_label, occurred_at, confirmation FROM evidence WHERE case_id = ? ORDER BY created_at, rowid'
			)
			.all(caseId) as unknown as EvidenceRow[];
		return rows.map(evidenceFromRow);
	}

	function recordFromRow(row: CaseRow): CaseRecord {
		return {
			...summaryFromRow(row),
			board: row.board_json ? backgroundBoardSchema.parse(JSON.parse(row.board_json)) : null,
			pendingBoard: row.pending_board_json
				? backgroundBoardSchema.parse(JSON.parse(row.pending_board_json))
				: null,
			evidence: getEvidence(row.id)
		};
	}

	return {
		createCase(input) {
			const parsed = newCaseSchema.parse(input);
			const id = randomUUID();
			const now = new Date().toISOString();
			database
				.prepare(
					'INSERT INTO cases (id, title, goal, confusion, stage, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)'
				)
				.run(id, parsed.title, parsed.goal, parsed.confusion, 'collecting', now, now);
			return recordFromRow(requireCase(id));
		},

		listCases() {
			const rows = database
				.prepare('SELECT * FROM cases ORDER BY updated_at DESC, rowid DESC')
				.all() as unknown as CaseRow[];
			return rows.map(summaryFromRow);
		},

		getCase(caseId) {
			const row = database.prepare('SELECT * FROM cases WHERE id = ?').get(caseId) as
				CaseRow | undefined;
			return row ? recordFromRow(row) : null;
		},

		appendEvidence(caseId, input) {
			const parsed = newEvidenceSchema.parse(input);
			const evidence = evidenceSchema.parse({ ...parsed, id: randomUUID() });
			const now = new Date().toISOString();
			database.exec('BEGIN IMMEDIATE');
			try {
				requireCase(caseId);
				database
					.prepare(
						'INSERT INTO evidence (id, case_id, kind, content, source_label, occurred_at, confirmation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
					)
					.run(
						evidence.id,
						caseId,
						evidence.kind,
						evidence.content,
						evidence.sourceLabel,
						evidence.occurredAt,
						evidence.confirmation,
						now
					);
				database
					.prepare(
						'UPDATE cases SET context_revision = context_revision + 1, current_guidance_id = NULL, updated_at = ? WHERE id = ?'
					)
					.run(now, caseId);
				database.exec('COMMIT');
			} catch (error) {
				database.exec('ROLLBACK');
				throw error;
			}
			return evidence;
		},

		appendCaseInput(caseId, input) {
			database.exec('BEGIN IMMEDIATE');
			try {
				const caseRow = requireCase(caseId);
				const parsed = caseInputSchema.parse(input);
				const existing = database
					.prepare(
						'SELECT id, case_id, request_id, kind, content, guidance_id, context_revision, created_at FROM case_inputs WHERE case_id = ? AND request_id = ?'
					)
					.get(caseId, parsed.requestId) as CaseInputRow | undefined;
				if (existing) {
					if (
						existing.kind !== parsed.kind ||
						existing.content !== parsed.content ||
						existing.guidance_id !== parsed.guidanceId
					) {
						throw new IdempotencyConflictError(parsed.requestId);
					}
					database.exec('COMMIT');
					return {
						outcome: 'replayed' as const,
						input: caseInputFromRow(existing),
						currentContextRevision: caseRow.context_revision
					};
				}
				if (parsed.guidanceId !== null) {
					const guidance = database
						.prepare('SELECT 1 FROM guidance_snapshots WHERE case_id = ? AND id = ?')
						.get(caseId, parsed.guidanceId);
					if (!guidance) throw new GuidanceReferenceError();
				}

				const id = randomUUID();
				const now = new Date().toISOString();
				const contextRevision = caseRow.context_revision + 1;
				database
					.prepare(
						'UPDATE cases SET context_revision = context_revision + 1, current_guidance_id = NULL, updated_at = ? WHERE id = ?'
					)
					.run(now, caseId);
				database
					.prepare(
						'INSERT INTO case_inputs (id, case_id, request_id, kind, content, guidance_id, context_revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
					)
					.run(
						id,
						caseId,
						parsed.requestId,
						parsed.kind,
						parsed.content,
						parsed.guidanceId,
						contextRevision,
						now
					);
				database.exec('COMMIT');
				return {
					outcome: 'inserted' as const,
					input: caseInputFromRow({
						id,
						case_id: caseId,
						request_id: parsed.requestId,
						kind: parsed.kind,
						content: parsed.content,
						guidance_id: parsed.guidanceId,
						context_revision: contextRevision,
						created_at: now
					}),
					currentContextRevision: contextRevision
				};
			} catch (error) {
				database.exec('ROLLBACK');
				throw error;
			}
		},

		listCaseInputs(caseId) {
			requireCase(caseId);
			const rows = database
				.prepare(
					'SELECT id, case_id, request_id, kind, content, guidance_id, context_revision, created_at FROM case_inputs WHERE case_id = ? ORDER BY sequence'
				)
				.all(caseId) as unknown as CaseInputRow[];
			return rows.map(caseInputFromRow);
		},

		getCaseContext(caseId) {
			const row = requireCase(caseId);
			return {
				contextRevision: row.context_revision,
				currentGuidanceId: row.current_guidance_id
			};
		},

		saveGuidance(
			caseId,
			expectedContextRevision,
			inputDraft,
			inputExternalClues,
			runId,
			degradation
		) {
			database.exec('BEGIN IMMEDIATE');
			try {
				requireCase(caseId);
				const draft = guidanceDraftSchema.parse(inputDraft);
				const externalClues = z.array(externalClueSchema).parse(inputExternalClues);
				const completeness = guidanceCompletenessSchema.parse(degradation?.completeness ?? 'full');
				const dropped = z.array(droppedGuidanceFieldSchema).parse(degradation?.dropped ?? []);
				validateGuidanceReferences(database, caseId, draft, externalClues);
				const existingRow = database
					.prepare(`SELECT ${GUIDANCE_COLUMNS} FROM guidance_snapshots WHERE run_id = ?`)
					.get(runId) as GuidanceRow | undefined;
				if (existingRow) {
					const existing = guidanceFromRow(existingRow);
					if (
						existing.caseId !== caseId ||
						existing.contextRevision !== expectedContextRevision ||
						JSON.stringify(existing.draft) !== JSON.stringify(draft) ||
						JSON.stringify(existing.externalClues) !== JSON.stringify(externalClues)
					) {
						throw new GuidanceRunConflictError(runId);
					}
					const currentCase = requireCase(caseId);
					database.exec('COMMIT');
					return {
						status:
							currentCase.current_guidance_id === existing.id
								? ('current' as const)
								: ('superseded' as const),
						snapshot: existing,
						currentContextRevision: currentCase.context_revision,
						currentGuidanceId: currentCase.current_guidance_id
					};
				}
				const id = randomUUID();
				const createdAt = new Date().toISOString();
				database
					.prepare(
						'INSERT INTO guidance_snapshots (id, case_id, run_id, context_revision, draft_json, external_clues_json, created_at, completeness, dropped_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
					)
					.run(
						id,
						caseId,
						runId,
						expectedContextRevision,
						JSON.stringify(draft),
						JSON.stringify(externalClues),
						createdAt,
						completeness,
						JSON.stringify(dropped)
					);
				const currentResult = database
					.prepare(
						'UPDATE cases SET current_guidance_id = ?, updated_at = ? WHERE id = ? AND context_revision = ?'
					)
					.run(id, createdAt, caseId, expectedContextRevision);
				const isCurrent = Number(currentResult.changes) === 1;
				const currentCase = requireCase(caseId);
				database.exec('COMMIT');
				const snapshot: GuidanceSnapshot = {
					id,
					caseId,
					runId,
					contextRevision: expectedContextRevision,
					createdAt,
					draft,
					externalClues,
					completeness,
					dropped
				};
				return {
					status: isCurrent ? ('current' as const) : ('superseded' as const),
					snapshot,
					currentContextRevision: currentCase.context_revision,
					currentGuidanceId: currentCase.current_guidance_id
				};
			} catch (error) {
				database.exec('ROLLBACK');
				throw error;
			}
		},

		getCurrentGuidance(caseId) {
			const caseRow = requireCase(caseId);
			if (!caseRow.current_guidance_id) return null;
			const row = database
				.prepare(`SELECT ${GUIDANCE_COLUMNS} FROM guidance_snapshots WHERE case_id = ? AND id = ?`)
				.get(caseId, caseRow.current_guidance_id) as GuidanceRow | undefined;
			return row ? guidanceFromRow(row) : null;
		},

		getGuidance(caseId, guidanceId) {
			requireCase(caseId);
			const row = database
				.prepare(`SELECT ${GUIDANCE_COLUMNS} FROM guidance_snapshots WHERE case_id = ? AND id = ?`)
				.get(caseId, guidanceId) as GuidanceRow | undefined;
			return row ? guidanceFromRow(row) : null;
		},

		listGuidance(caseId, limit) {
			requireCase(caseId);
			const rows = (limit === undefined
				? database
						.prepare(
							`SELECT ${GUIDANCE_COLUMNS} FROM guidance_snapshots WHERE case_id = ? ORDER BY sequence`
						)
						.all(caseId)
				: database
						.prepare(
							`SELECT ${GUIDANCE_COLUMNS} FROM guidance_snapshots WHERE case_id = ? ORDER BY sequence DESC LIMIT ?`
						)
						.all(caseId, limit)) as unknown as GuidanceRow[];
			if (limit !== undefined) rows.reverse();
			return rows.map(guidanceFromRow);
		},

		saveBoard(caseId, expectedRevision, inputBoard) {
			const board = backgroundBoardSchema.parse(inputBoard);
			if (board.caseId !== caseId) throw new Error('背景板与案例不一致');
			const now = new Date().toISOString();
			const result = database
				.prepare(
					'UPDATE cases SET board_json = ?, pending_board_json = NULL, pending_revision = NULL, stage = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?'
				)
				.run(
					JSON.stringify({ ...board, updatedAt: now }),
					board.stage,
					now,
					caseId,
					expectedRevision
				);
			if (Number(result.changes) !== 1) {
				if (!this.getCase(caseId)) throw new CaseNotFoundError(caseId);
				throw new RevisionConflictError();
			}
			return recordFromRow(requireCase(caseId));
		},

		confirmEvidence(caseId, evidenceId) {
			const now = new Date().toISOString();
			database.exec('BEGIN IMMEDIATE');
			try {
				requireCase(caseId);
				const result = database
					.prepare(
						'UPDATE evidence SET confirmation = ? WHERE id = ? AND case_id = ? AND confirmation <> ?'
					)
					.run('official', evidenceId, caseId, 'official');
				const evidence = getEvidence(caseId).find((item) => item.id === evidenceId);
				if (!evidence) throw new EvidenceNotFoundError(evidenceId);
				if (Number(result.changes) === 1) {
					database
						.prepare(
							'UPDATE cases SET context_revision = context_revision + 1, current_guidance_id = NULL, updated_at = ? WHERE id = ?'
						)
						.run(now, caseId);
				}
				database.exec('COMMIT');
				return evidence;
			} catch (error) {
				database.exec('ROLLBACK');
				throw error;
			}
		},

		stageBoardProposal(caseId, expectedRevision, inputBoard) {
			const board = backgroundBoardSchema.parse(inputBoard);
			if (board.caseId !== caseId) throw new Error('背景板与案例不一致');
			const now = new Date().toISOString();
			const result = database
				.prepare(
					'UPDATE cases SET pending_board_json = ?, pending_revision = ?, updated_at = ? WHERE id = ? AND revision = ?'
				)
				.run(
					JSON.stringify({ ...board, updatedAt: now }),
					expectedRevision,
					now,
					caseId,
					expectedRevision
				);
			if (Number(result.changes) !== 1) {
				if (!this.getCase(caseId)) throw new CaseNotFoundError(caseId);
				throw new RevisionConflictError();
			}
			return recordFromRow(requireCase(caseId));
		},

		confirmBoardProposal(caseId, expectedRevision) {
			const row = requireCase(caseId);
			if (
				row.revision !== expectedRevision ||
				row.pending_revision !== expectedRevision ||
				!row.pending_board_json
			) {
				throw new RevisionConflictError();
			}
			const board = backgroundBoardSchema.parse(JSON.parse(row.pending_board_json));
			const now = new Date().toISOString();
			const result = database
				.prepare(
					'UPDATE cases SET board_json = ?, pending_board_json = NULL, pending_revision = NULL, stage = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND pending_revision = ?'
				)
				.run(
					JSON.stringify({ ...board, updatedAt: now }),
					board.stage,
					now,
					caseId,
					expectedRevision,
					expectedRevision
				);
			if (Number(result.changes) !== 1) throw new RevisionConflictError();
			return recordFromRow(requireCase(caseId));
		},

		discardBoardProposal(caseId, expectedRevision) {
			const result = database
				.prepare(
					'UPDATE cases SET pending_board_json = NULL, pending_revision = NULL WHERE id = ? AND revision = ? AND pending_revision = ?'
				)
				.run(caseId, expectedRevision, expectedRevision);
			if (Number(result.changes) !== 1) {
				if (!this.getCase(caseId)) throw new CaseNotFoundError(caseId);
				throw new RevisionConflictError();
			}
			return recordFromRow(requireCase(caseId));
		},

		appendEvent(caseId, event) {
			requireCase(caseId);
			const id = randomUUID();
			const createdAt = new Date().toISOString();
			database
				.prepare(
					'INSERT INTO events (id, case_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)'
				)
				.run(id, caseId, event.type, JSON.stringify(event.payload), createdAt);
			return { id, caseId, type: event.type, payload: event.payload, createdAt };
		},

		listEvents(caseId) {
			requireCase(caseId);
			const rows = database
				.prepare(
					'SELECT id, case_id, type, payload_json, created_at FROM events WHERE case_id = ? ORDER BY sequence'
				)
				.all(caseId) as unknown as EventRow[];
			return rows.map((row) => ({
				id: row.id,
				caseId: row.case_id,
				type: row.type,
				payload: JSON.parse(row.payload_json) as Record<string, unknown>,
				createdAt: row.created_at
			}));
		},

		close() {
			database.close();
		}
	};
}

export type { DatabaseSync };
