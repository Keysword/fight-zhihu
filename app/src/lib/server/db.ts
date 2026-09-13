import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(path: string): DatabaseSync {
	if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
	const database = new DatabaseSync(path);
	database.exec('PRAGMA journal_mode = WAL');
	database.exec('PRAGMA foreign_keys = ON');
	database.exec('PRAGMA busy_timeout = 5000');
	database.exec('BEGIN IMMEDIATE');
	try {
		database.exec(`
			CREATE TABLE IF NOT EXISTS cases (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				goal TEXT NOT NULL,
				confusion TEXT NOT NULL,
				stage TEXT NOT NULL,
				revision INTEGER NOT NULL DEFAULT 0,
				board_json TEXT,
				pending_board_json TEXT,
				pending_revision INTEGER,
				context_revision INTEGER NOT NULL DEFAULT 0,
				current_guidance_id TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS evidence (
				id TEXT PRIMARY KEY,
				case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
				kind TEXT NOT NULL,
				content TEXT NOT NULL,
				source_label TEXT NOT NULL,
				occurred_at TEXT,
				confirmation TEXT NOT NULL DEFAULT 'self_reported',
				created_at TEXT NOT NULL
			);

			CREATE INDEX IF NOT EXISTS evidence_case_created
				ON evidence(case_id, created_at);

			CREATE TABLE IF NOT EXISTS events (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT,
				id TEXT NOT NULL UNIQUE,
				case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
				type TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				created_at TEXT NOT NULL
			);

			CREATE INDEX IF NOT EXISTS events_case_sequence
				ON events(case_id, sequence);
		`);

		const caseColumns = database.prepare('PRAGMA table_info(cases)').all() as unknown as Array<{
			name: string;
		}>;
		if (!caseColumns.some((column) => column.name === 'pending_board_json')) {
			database.exec('ALTER TABLE cases ADD COLUMN pending_board_json TEXT');
		}
		if (!caseColumns.some((column) => column.name === 'pending_revision')) {
			database.exec('ALTER TABLE cases ADD COLUMN pending_revision INTEGER');
		}
		if (!caseColumns.some((column) => column.name === 'context_revision')) {
			database.exec('ALTER TABLE cases ADD COLUMN context_revision INTEGER NOT NULL DEFAULT 0');
		}
		if (!caseColumns.some((column) => column.name === 'current_guidance_id')) {
			database.exec('ALTER TABLE cases ADD COLUMN current_guidance_id TEXT');
		}

		const evidenceColumns = database
			.prepare('PRAGMA table_info(evidence)')
			.all() as unknown as Array<{
			name: string;
		}>;
		if (!evidenceColumns.some((column) => column.name === 'confirmation')) {
			database.exec(
				"ALTER TABLE evidence ADD COLUMN confirmation TEXT NOT NULL DEFAULT 'self_reported'"
			);
			database.exec("UPDATE evidence SET confirmation = 'official' WHERE kind = 'notice'");
		}

		database.exec(`
			CREATE TABLE IF NOT EXISTS case_inputs (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT,
				id TEXT NOT NULL UNIQUE,
				case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
				request_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				content TEXT NOT NULL,
				guidance_id TEXT,
				context_revision INTEGER NOT NULL,
				created_at TEXT NOT NULL,
				UNIQUE(case_id, request_id),
				UNIQUE(case_id, context_revision)
			);

			CREATE INDEX IF NOT EXISTS case_inputs_case_sequence
				ON case_inputs(case_id, sequence);

			CREATE TABLE IF NOT EXISTS guidance_snapshots (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT,
				id TEXT NOT NULL UNIQUE,
				case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
				run_id TEXT NOT NULL UNIQUE,
				context_revision INTEGER NOT NULL,
				draft_json TEXT NOT NULL,
				external_clues_json TEXT NOT NULL,
				created_at TEXT NOT NULL
			);

			CREATE INDEX IF NOT EXISTS guidance_snapshots_case_sequence
				ON guidance_snapshots(case_id, sequence);

			CREATE TRIGGER IF NOT EXISTS cases_current_guidance_same_case
			BEFORE UPDATE OF current_guidance_id ON cases
			WHEN NEW.current_guidance_id IS NOT NULL
				AND NOT EXISTS (
					SELECT 1 FROM guidance_snapshots
					WHERE id = NEW.current_guidance_id AND case_id = NEW.id
				)
			BEGIN
				SELECT RAISE(ABORT, 'current guidance must belong to case');
			END;

			CREATE TRIGGER IF NOT EXISTS case_inputs_guidance_same_case_insert
			BEFORE INSERT ON case_inputs
			WHEN NEW.guidance_id IS NOT NULL
				AND NOT EXISTS (
					SELECT 1 FROM guidance_snapshots
					WHERE id = NEW.guidance_id AND case_id = NEW.case_id
				)
			BEGIN
				SELECT RAISE(ABORT, 'input guidance must belong to case');
			END;
		`);

		const guidanceColumns = database
			.prepare('PRAGMA table_info(guidance_snapshots)')
			.all() as unknown as Array<{ name: string }>;
		if (!guidanceColumns.some((column) => column.name === 'completeness')) {
			database.exec(
				"ALTER TABLE guidance_snapshots ADD COLUMN completeness TEXT NOT NULL DEFAULT 'full'"
			);
		}
		if (!guidanceColumns.some((column) => column.name === 'dropped_json')) {
			database.exec(
				"ALTER TABLE guidance_snapshots ADD COLUMN dropped_json TEXT NOT NULL DEFAULT '[]'"
			);
		}

		database.exec('COMMIT');
	} catch (error) {
		database.exec('ROLLBACK');
		database.close();
		throw error;
	}
	return database;
}
