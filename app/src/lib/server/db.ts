import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(path: string): DatabaseSync {
	if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
	const database = new DatabaseSync(path);
	database.exec('PRAGMA journal_mode = WAL');
	database.exec('PRAGMA foreign_keys = ON');
	database.exec('PRAGMA busy_timeout = 5000');
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
	return database;
}
