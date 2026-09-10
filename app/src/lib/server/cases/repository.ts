import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

import { backgroundBoardSchema, evidenceSchema } from '$lib/domain/schemas';
import type {
	AgentEvent,
	BackgroundBoard,
	CaseRecord,
	CaseStage,
	CaseSummary,
	Evidence
} from '$lib/domain/types';
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

export interface CaseRepository {
	createCase(input: z.input<typeof newCaseSchema>): CaseRecord;
	listCases(): CaseSummary[];
	getCase(caseId: string): CaseRecord | null;
	appendEvidence(caseId: string, input: z.input<typeof newEvidenceSchema>): Evidence;
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
			requireCase(caseId);
			const parsed = newEvidenceSchema.parse(input);
			const evidence = evidenceSchema.parse({ ...parsed, id: randomUUID() });
			const now = new Date().toISOString();
			database.exec('BEGIN IMMEDIATE');
			try {
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
				database.prepare('UPDATE cases SET updated_at = ? WHERE id = ?').run(now, caseId);
				database.exec('COMMIT');
			} catch (error) {
				database.exec('ROLLBACK');
				throw error;
			}
			return evidence;
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
			requireCase(caseId);
			const now = new Date().toISOString();
			const result = database
				.prepare('UPDATE evidence SET confirmation = ? WHERE id = ? AND case_id = ?')
				.run('official', evidenceId, caseId);
			if (Number(result.changes) !== 1) throw new EvidenceNotFoundError(evidenceId);
			database.prepare('UPDATE cases SET updated_at = ? WHERE id = ?').run(now, caseId);
			const evidence = getEvidence(caseId).find((item) => item.id === evidenceId);
			if (!evidence) throw new EvidenceNotFoundError(evidenceId);
			return evidence;
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
