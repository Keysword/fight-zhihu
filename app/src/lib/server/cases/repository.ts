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
	created_at: string;
	updated_at: string;
}

interface EvidenceRow {
	id: string;
	kind: Evidence['kind'];
	content: string;
	source_label: string;
	occurred_at: string | null;
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
		occurredAt: row.occurred_at
	});
}

export interface CaseRepository {
	createCase(input: z.input<typeof newCaseSchema>): CaseRecord;
	listCases(): CaseSummary[];
	getCase(caseId: string): CaseRecord | null;
	appendEvidence(caseId: string, input: z.input<typeof newEvidenceSchema>): Evidence;
	saveBoard(caseId: string, expectedRevision: number, board: BackgroundBoard): CaseRecord;
	appendEvent(caseId: string, event: { type: string; payload: Record<string, unknown> }): AgentEvent;
	listEvents(caseId: string): AgentEvent[];
	close(): void;
}

export function createCaseRepository(path: string): CaseRepository {
	const database = openDatabase(path);

	function requireCase(caseId: string): CaseRow {
		const row = database.prepare('SELECT * FROM cases WHERE id = ?').get(caseId) as
			| CaseRow
			| undefined;
		if (!row) throw new CaseNotFoundError(caseId);
		return row;
	}

	function getEvidence(caseId: string): Evidence[] {
		const rows = database
			.prepare(
				'SELECT id, kind, content, source_label, occurred_at FROM evidence WHERE case_id = ? ORDER BY created_at, rowid'
			)
			.all(caseId) as unknown as EvidenceRow[];
		return rows.map(evidenceFromRow);
	}

	function recordFromRow(row: CaseRow): CaseRecord {
		return {
			...summaryFromRow(row),
			board: row.board_json ? backgroundBoardSchema.parse(JSON.parse(row.board_json)) : null,
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
				| CaseRow
				| undefined;
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
						'INSERT INTO evidence (id, case_id, kind, content, source_label, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
					)
					.run(
						evidence.id,
						caseId,
						evidence.kind,
						evidence.content,
						evidence.sourceLabel,
						evidence.occurredAt,
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
					'UPDATE cases SET board_json = ?, stage = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?'
				)
				.run(JSON.stringify({ ...board, updatedAt: now }), board.stage, now, caseId, expectedRevision);
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
