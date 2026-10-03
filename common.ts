import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = import.meta.dirname;
export const config = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
export const bot = `${config.appSlug}[bot]`;

const dbPath = process.env.CHECKNORRIS_DB ?? config.db ?? "checknorris.db";
export const db = new DatabaseSync(dbPath === ":memory:" ? dbPath : path.resolve(root, dbPath));
db.exec(`
  CREATE TABLE IF NOT EXISTS prs (
    repo TEXT, number INTEGER, title TEXT, url TEXT, author TEXT, state TEXT,
    head_sha TEXT, updated_at TEXT, reviewed_sha TEXT, failed_sha TEXT, failures INTEGER DEFAULT 0, failed_at TEXT, summary_comment_id INTEGER, comments_since TEXT,
    PRIMARY KEY (repo, number));
  CREATE TABLE IF NOT EXISTS mentions (
    id INTEGER PRIMARY KEY, repo TEXT, number INTEGER, kind TEXT, author TEXT, body TEXT,
    url TEXT, created_at TEXT, handled INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT, number INTEGER, head_sha TEXT, kind TEXT, score INTEGER, approved INTEGER,
  summary TEXT, rationale TEXT, comments TEXT, model TEXT, tokens_in INTEGER, tokens_out INTEGER, seconds REAL, created_at TEXT);
`);
// Migrations for databases created by earlier versions. Ignore "duplicate column".
for (const sql of ["ALTER TABLE prs ADD COLUMN failed_sha TEXT", "ALTER TABLE prs ADD COLUMN failures INTEGER DEFAULT 0", "ALTER TABLE prs ADD COLUMN failed_at TEXT", "ALTER TABLE prs ADD COLUMN summary_comment_id INTEGER", "ALTER TABLE reviews ADD COLUMN rationale TEXT"]) { try { db.exec(sql); } catch {} }


export type Gh = (p: string, init?: RequestInit) => Promise<any>;
