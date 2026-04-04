import Database from "better-sqlite3";
import { resolve, dirname } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { buildDefaultSetupProfiles, DEFAULT_SETUP_PROFILE_NAMES } from "./setup-profiles.js";
import type {
  CandidateReport,
  IssueRef,
  ScanPerformanceMetrics,
  ScanReport,
  ScanStatus,
  SearchRepo,
  SetupProfile,
  SetupRunRecord,
  SetupRunStatus,
  SetupTargetType,
  StepTiming,
} from "./types.js";

let _db: Database.Database | undefined;

export function getDb(dbPath: string): Database.Database {
  if (_db) return _db;
  const resolved = resolve(dbPath);
  const dir = dirname(resolved);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  _db = new Database(resolved);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  migrate(_db);
  return _db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name     TEXT UNIQUE NOT NULL,
      owner         TEXT NOT NULL,
      name          TEXT NOT NULL,
      url           TEXT NOT NULL,
      stars         INTEGER NOT NULL DEFAULT 0,
      primary_language TEXT,
      default_branch TEXT NOT NULL DEFAULT 'main',
      description   TEXT,
      is_archived   INTEGER NOT NULL DEFAULT 0,
      pushed_at     TEXT,
      disk_usage_kb INTEGER,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pull_requests (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id       INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      number        INTEGER NOT NULL,
      url           TEXT NOT NULL,
      title         TEXT NOT NULL,
      body          TEXT,
      merged_at     TEXT,
      changed_files INTEGER,
      labels        TEXT,
      base_ref_name TEXT NOT NULL,
      base_ref_oid  TEXT NOT NULL,
      head_ref_oid  TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(repo_id, number)
    );

    CREATE TABLE IF NOT EXISTS issues (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id         INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
      owner         TEXT NOT NULL,
      repo          TEXT NOT NULL,
      number        INTEGER NOT NULL,
      url           TEXT,
      title         TEXT,
      body          TEXT,
      state         TEXT,
      link_type     TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(pr_id, owner, repo, number)
    );

    CREATE TABLE IF NOT EXISTS scans (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      status        TEXT NOT NULL DEFAULT 'running',
      config_json   TEXT NOT NULL,
      started_at    TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at   TEXT,
      total_duration_ms INTEGER,
      accepted_count  INTEGER NOT NULL DEFAULT 0,
      rejected_count  INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS scan_candidates (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id         INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
      repo_id         INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      pr_id           INTEGER REFERENCES pull_requests(id) ON DELETE SET NULL,
      accepted        INTEGER NOT NULL DEFAULT 0,
      pre_fix_sha     TEXT,
      rejection_reasons TEXT,
      tests_unable_to_run INTEGER NOT NULL DEFAULT 0,
      tests_unable_to_run_reason TEXT,
      timings_json    TEXT,
      details_json    TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS setup_profiles (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      name                  TEXT NOT NULL UNIQUE,
      prompt                TEXT NOT NULL,
      context_paths_json    TEXT NOT NULL,
      writable_paths_json   TEXT NOT NULL,
      validation_commands_json TEXT NOT NULL,
      validation_prompt     TEXT NOT NULL DEFAULT '',
      clone_root_path       TEXT NOT NULL DEFAULT '',
      model                 TEXT,
      sandbox_mode          TEXT NOT NULL DEFAULT 'workspace-write',
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS setup_runs (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type           TEXT NOT NULL DEFAULT 'repo',
      target_label          TEXT NOT NULL DEFAULT '',
      repo_id               INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      issue_id              INTEGER REFERENCES issues(id) ON DELETE SET NULL,
      issue_number          INTEGER,
      issue_title           TEXT,
      profile_id            INTEGER REFERENCES setup_profiles(id) ON DELETE SET NULL,
      status                TEXT NOT NULL DEFAULT 'running',
      prompt                TEXT NOT NULL,
      context_paths_json    TEXT NOT NULL,
      writable_paths_json   TEXT NOT NULL,
      validation_commands_json TEXT NOT NULL,
      validation_prompt     TEXT NOT NULL DEFAULT '',
      clone_root_path       TEXT NOT NULL DEFAULT '',
      model                 TEXT,
      sandbox_mode          TEXT NOT NULL,
      worktree_path         TEXT,
      stdout_path           TEXT,
      stderr_path           TEXT,
      last_message_path     TEXT,
      diff_path             TEXT,
      summary               TEXT,
      changed_files_json    TEXT,
      violation_files_json  TEXT,
      error                 TEXT,
      started_at            TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at           TEXT
    );
  `);

  const scanColumns = db.prepare("PRAGMA table_info(scans)").all() as Array<{ name: string }>;
  if (!scanColumns.some((column) => column.name === "metrics_json")) {
    db.exec("ALTER TABLE scans ADD COLUMN metrics_json TEXT");
  }

  const setupProfileColumns = db.prepare("PRAGMA table_info(setup_profiles)").all() as Array<{ name: string }>;
  if (!setupProfileColumns.some((column) => column.name === "validation_prompt")) {
    db.exec("ALTER TABLE setup_profiles ADD COLUMN validation_prompt TEXT NOT NULL DEFAULT ''");
  }
  if (!setupProfileColumns.some((column) => column.name === "clone_root_path")) {
    db.exec("ALTER TABLE setup_profiles ADD COLUMN clone_root_path TEXT NOT NULL DEFAULT ''");
  }

  const setupRunColumns = db.prepare("PRAGMA table_info(setup_runs)").all() as Array<{ name: string }>;
  if (!setupRunColumns.some((column) => column.name === "target_type")) {
    db.exec("ALTER TABLE setup_runs ADD COLUMN target_type TEXT NOT NULL DEFAULT 'repo'");
  }
  if (!setupRunColumns.some((column) => column.name === "target_label")) {
    db.exec("ALTER TABLE setup_runs ADD COLUMN target_label TEXT NOT NULL DEFAULT ''");
  }
  if (!setupRunColumns.some((column) => column.name === "issue_id")) {
    db.exec("ALTER TABLE setup_runs ADD COLUMN issue_id INTEGER REFERENCES issues(id) ON DELETE SET NULL");
  }
  if (!setupRunColumns.some((column) => column.name === "issue_number")) {
    db.exec("ALTER TABLE setup_runs ADD COLUMN issue_number INTEGER");
  }
  if (!setupRunColumns.some((column) => column.name === "issue_title")) {
    db.exec("ALTER TABLE setup_runs ADD COLUMN issue_title TEXT");
  }
  if (!setupRunColumns.some((column) => column.name === "validation_prompt")) {
    db.exec("ALTER TABLE setup_runs ADD COLUMN validation_prompt TEXT NOT NULL DEFAULT ''");
  }
  if (!setupRunColumns.some((column) => column.name === "clone_root_path")) {
    db.exec("ALTER TABLE setup_runs ADD COLUMN clone_root_path TEXT NOT NULL DEFAULT ''");
  }

  seedDefaultSetupProfiles(db);
}

export function resetDatabase(db: Database.Database): void {
  const reset = db.transaction(() => {
    db.prepare("DELETE FROM setup_runs").run();
    db.prepare("DELETE FROM setup_profiles").run();
    db.prepare("DELETE FROM scan_candidates").run();
    db.prepare("DELETE FROM issues").run();
    db.prepare("DELETE FROM pull_requests").run();
    db.prepare("DELETE FROM repos").run();
    db.prepare("DELETE FROM scans").run();
    db.prepare(`
      DELETE FROM sqlite_sequence
      WHERE name IN ('repos', 'pull_requests', 'issues', 'scans', 'scan_candidates', 'setup_profiles', 'setup_runs')
    `).run();
  });

  reset();
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.exec("VACUUM");
}

/* ------------------------------------------------------------------ */
/* Repos                                                               */
/* ------------------------------------------------------------------ */

export function upsertRepo(db: Database.Database, repo: SearchRepo): number {
  const stmt = db.prepare(`
    INSERT INTO repos (full_name, owner, name, url, stars, primary_language, default_branch, description, is_archived, pushed_at, disk_usage_kb, updated_at)
    VALUES (@fullName, @owner, @name, @url, @stars, @primaryLanguage, @defaultBranch, @description, @isArchived, @pushedAt, @diskUsageKb, datetime('now'))
    ON CONFLICT(full_name) DO UPDATE SET
      stars = @stars,
      primary_language = @primaryLanguage,
      description = @description,
      is_archived = @isArchived,
      pushed_at = @pushedAt,
      disk_usage_kb = @diskUsageKb,
      updated_at = datetime('now')
  `);
  stmt.run({
    fullName: repo.fullName,
    owner: repo.owner,
    name: repo.name,
    url: repo.url,
    stars: repo.stars,
    primaryLanguage: repo.primaryLanguage ?? null,
    defaultBranch: repo.defaultBranch,
    description: repo.description ?? null,
    isArchived: repo.isArchived ? 1 : 0,
    pushedAt: repo.pushedAt ?? null,
    diskUsageKb: repo.diskUsageKb ?? null,
  });
  const row = db.prepare("SELECT id FROM repos WHERE full_name = ?").get(repo.fullName) as { id: number };
  return row.id;
}

export function repoHasAcceptedCandidate(db: Database.Database, fullName: string): boolean {
  const row = db.prepare(`
    SELECT 1 FROM scan_candidates sc
    JOIN repos r ON r.id = sc.repo_id
    WHERE r.full_name = ? AND sc.accepted = 1
    LIMIT 1
  `).get(fullName) as { 1: number } | undefined;
  return Boolean(row);
}

export function getRepos(db: Database.Database, opts: { search?: string; limit?: number; offset?: number } = {}): { rows: any[]; total: number } {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const where = opts.search ? "WHERE r.full_name LIKE @search OR r.description LIKE @search" : "";
  const params: any = opts.search ? { search: `%${opts.search}%` } : {};
  const candidateSummaryCte = `
    WITH latest_candidates AS (
      SELECT
        sc.*,
        ROW_NUMBER() OVER (
          PARTITION BY sc.repo_id, COALESCE(sc.pr_id, -sc.id)
          ORDER BY sc.id DESC
        ) AS row_rank
      FROM scan_candidates sc
    ),
    single_issue_candidates AS (
      SELECT
        lc.id AS candidate_id,
        lc.repo_id,
        lc.pr_id,
        MIN(i.owner) AS issue_owner,
        MIN(i.repo) AS issue_repo,
        MIN(i.number) AS issue_number
      FROM latest_candidates lc
      JOIN issues i ON i.pr_id = lc.pr_id
      WHERE lc.row_rank = 1
        AND COALESCE(json_extract(lc.details_json, '$.analysis.accepted'), 0) = 1
      GROUP BY lc.id, lc.repo_id, lc.pr_id
      HAVING COUNT(*) = 1
    ),
    qualified_candidates AS (
      SELECT
        sic.candidate_id,
        sic.repo_id,
        sic.pr_id
      FROM single_issue_candidates sic
      WHERE (
        SELECT COUNT(DISTINCT i2.pr_id)
        FROM issues i2
        WHERE i2.owner = sic.issue_owner
          AND i2.repo = sic.issue_repo
          AND i2.number = sic.issue_number
      ) = 1
    )
  `;

  const total = (db.prepare(`SELECT COUNT(*) as cnt FROM repos r ${where}`).get(params) as any).cnt;
  const rows = db.prepare(`
    ${candidateSummaryCte}
    SELECT r.*,
      (SELECT COUNT(*) FROM latest_candidates lc WHERE lc.repo_id = r.id AND lc.row_rank = 1 AND lc.accepted = 1) as accepted_count,
      (SELECT COUNT(*) FROM latest_candidates lc WHERE lc.repo_id = r.id AND lc.row_rank = 1 AND lc.accepted = 0) as rejected_count,
      (SELECT COUNT(*) FROM latest_candidates lc WHERE lc.repo_id = r.id AND lc.row_rank = 1 AND lc.pr_id IS NOT NULL) as scanned_pr_count,
      (SELECT COUNT(*) FROM latest_candidates lc WHERE lc.repo_id = r.id AND lc.row_rank = 1 AND lc.pr_id IS NOT NULL AND COALESCE(json_extract(lc.details_json, '$.basicFilterPassed'), 0) = 1) as basic_filter_pass_count,
      (SELECT COUNT(*) FROM qualified_candidates qc WHERE qc.repo_id = r.id) as pr_count,
      (SELECT COUNT(*) FROM qualified_candidates qc WHERE qc.repo_id = r.id) as issue_count
    FROM repos r ${where}
    ORDER BY r.updated_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `).all(params);
  return { rows, total };
}

export function getRepoById(db: Database.Database, id: number): any {
  const repo = db.prepare("SELECT * FROM repos WHERE id = ?").get(id);
  if (!repo) return undefined;
  const prs = db.prepare(`
    SELECT pr.*, 
      (SELECT COUNT(*) FROM issues i WHERE i.pr_id = pr.id) as issue_count
    FROM pull_requests pr WHERE pr.repo_id = ? ORDER BY pr.merged_at DESC
  `).all(id);
  const issues = db.prepare(`
    SELECT i.*, pr.number as pr_number, pr.title as pr_title
    FROM issues i
    JOIN pull_requests pr ON pr.id = i.pr_id
    WHERE pr.repo_id = ?
    ORDER BY i.created_at DESC
  `).all(id);
  const candidates = db.prepare(`
    SELECT sc.* FROM scan_candidates sc WHERE sc.repo_id = ? ORDER BY sc.created_at DESC
  `).all(id);
  return { ...repo as any, pullRequests: prs, issues, candidates };
}

export function getRepoRecordById(db: Database.Database, id: number): any {
  return db.prepare("SELECT * FROM repos WHERE id = ?").get(id);
}

export function deleteRepo(db: Database.Database, id: number): boolean {
  const result = db.prepare("DELETE FROM repos WHERE id = ?").run(id);
  return result.changes > 0;
}

/* ------------------------------------------------------------------ */
/* Setup Profiles / Runs                                               */
/* ------------------------------------------------------------------ */

function parseJsonList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function defaultSetupCloneRoot(): string {
  return resolve(`${homedir()}/Documents/pr-writer-tasks`);
}

function seedDefaultSetupProfiles(db: Database.Database): void {
  const cloneRootPath = defaultSetupCloneRoot();
  const profiles = buildDefaultSetupProfiles(cloneRootPath);
  const defaultProfileNames = Object.values(DEFAULT_SETUP_PROFILE_NAMES);
  const pythonProfile = profiles.find((profile) => profile.name === DEFAULT_SETUP_PROFILE_NAMES.python);

  if (pythonProfile) {
    db.prepare(`
      UPDATE setup_profiles
      SET
        name = ?,
        prompt = ?,
        context_paths_json = ?,
        writable_paths_json = ?,
        validation_commands_json = ?,
        validation_prompt = ?,
        clone_root_path = ?,
        model = ?,
        sandbox_mode = ?,
        updated_at = datetime('now')
      WHERE name = 'Default Docker Setup'
        AND NOT EXISTS (SELECT 1 FROM setup_profiles WHERE name = ?)
    `).run(
      pythonProfile.name,
      pythonProfile.prompt,
      JSON.stringify(pythonProfile.contextPaths),
      JSON.stringify(pythonProfile.writablePaths),
      JSON.stringify([]),
      pythonProfile.validationPrompt,
      pythonProfile.cloneRootPath,
      pythonProfile.model ?? null,
      pythonProfile.sandboxMode,
      pythonProfile.name,
    );
  }

  for (const profile of profiles) {
    db.prepare(`
      INSERT INTO setup_profiles (name, prompt, context_paths_json, writable_paths_json, validation_commands_json, validation_prompt, clone_root_path, model, sandbox_mode)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM setup_profiles WHERE name = ?)
    `).run(
      profile.name,
      profile.prompt,
      JSON.stringify(profile.contextPaths),
      JSON.stringify(profile.writablePaths),
      JSON.stringify([]),
      profile.validationPrompt,
      profile.cloneRootPath,
      profile.model ?? null,
      profile.sandboxMode,
      profile.name,
    );
  }

  db.prepare(`
    UPDATE setup_profiles
    SET sandbox_mode = 'danger-full-access',
        updated_at = CASE
          WHEN sandbox_mode <> 'danger-full-access' THEN datetime('now')
          ELSE updated_at
        END
    WHERE name IN (${defaultProfileNames.map(() => "?").join(", ")})
  `).run(...defaultProfileNames);
}

function parseValidationPrompt(rawPrompt: unknown, legacyCommands: string | null | undefined): string {
  if (typeof rawPrompt === "string" && rawPrompt.trim()) {
    return rawPrompt;
  }
  const commands = parseJsonList(legacyCommands);
  if (!commands.length) {
    return "";
  }
  return `Validate the result using these commands if they still make sense:\n${commands.map((command) => `- ${command}`).join("\n")}`;
}

function mapSetupProfileRow(row: any): SetupProfile {
  return {
    id: Number(row.id),
    name: String(row.name),
    prompt: String(row.prompt),
    contextPaths: parseJsonList(row.context_paths_json),
    writablePaths: parseJsonList(row.writable_paths_json),
    validationPrompt: parseValidationPrompt(row.validation_prompt, row.validation_commands_json),
    cloneRootPath: typeof row.clone_root_path === "string" && row.clone_root_path ? row.clone_root_path : defaultSetupCloneRoot(),
    model: typeof row.model === "string" && row.model ? row.model : undefined,
    sandboxMode: row.sandbox_mode === "danger-full-access" ? "danger-full-access" : "workspace-write",
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapSetupRunRow(row: any): SetupRunRecord {
  return {
    id: Number(row.id),
    targetType: row.target_type === "issue" ? "issue" : "repo",
    targetLabel: typeof row.target_label === "string" && row.target_label ? row.target_label : String(row.repo_full_name),
    repoId: Number(row.repo_id),
    repoFullName: String(row.repo_full_name),
    issueId: typeof row.issue_id === "number" ? row.issue_id : undefined,
    issueNumber: typeof row.issue_number === "number" ? row.issue_number : undefined,
    issueTitle: typeof row.issue_title === "string" && row.issue_title ? row.issue_title : undefined,
    profileId: typeof row.profile_id === "number" ? row.profile_id : undefined,
    profileName: typeof row.profile_name === "string" && row.profile_name ? row.profile_name : undefined,
    status: row.status === "completed" || row.status === "failed" || row.status === "stopped" ? row.status : "running",
    prompt: String(row.prompt),
    contextPaths: parseJsonList(row.context_paths_json),
    writablePaths: parseJsonList(row.writable_paths_json),
    validationPrompt: parseValidationPrompt(row.validation_prompt, row.validation_commands_json),
    cloneRootPath: typeof row.clone_root_path === "string" && row.clone_root_path ? row.clone_root_path : defaultSetupCloneRoot(),
    model: typeof row.model === "string" && row.model ? row.model : undefined,
    sandboxMode: row.sandbox_mode === "danger-full-access" ? "danger-full-access" : "workspace-write",
    worktreePath: typeof row.worktree_path === "string" && row.worktree_path ? row.worktree_path : undefined,
    stdoutPath: typeof row.stdout_path === "string" && row.stdout_path ? row.stdout_path : undefined,
    stderrPath: typeof row.stderr_path === "string" && row.stderr_path ? row.stderr_path : undefined,
    lastMessagePath: typeof row.last_message_path === "string" && row.last_message_path ? row.last_message_path : undefined,
    diffPath: typeof row.diff_path === "string" && row.diff_path ? row.diff_path : undefined,
    summary: typeof row.summary === "string" && row.summary ? row.summary : undefined,
    changedFiles: parseJsonList(row.changed_files_json),
    violationFiles: parseJsonList(row.violation_files_json),
    error: typeof row.error === "string" && row.error ? row.error : undefined,
    startedAt: String(row.started_at),
    finishedAt: typeof row.finished_at === "string" && row.finished_at ? row.finished_at : undefined,
  };
}

export function getSetupProfiles(db: Database.Database): SetupProfile[] {
  const rows = db.prepare("SELECT * FROM setup_profiles ORDER BY updated_at DESC, id DESC").all();
  return rows.map((row) => mapSetupProfileRow(row));
}

export function getSetupProfileById(db: Database.Database, id: number): SetupProfile | undefined {
  const row = db.prepare("SELECT * FROM setup_profiles WHERE id = ?").get(id);
  return row ? mapSetupProfileRow(row) : undefined;
}

export function createSetupProfile(
  db: Database.Database,
  input: {
    name: string;
    prompt: string;
    contextPaths: string[];
    writablePaths: string[];
    validationPrompt: string;
    cloneRootPath: string;
    model?: string;
    sandboxMode: "workspace-write" | "danger-full-access";
  },
): number {
  const result = db.prepare(`
    INSERT INTO setup_profiles (name, prompt, context_paths_json, writable_paths_json, validation_commands_json, validation_prompt, clone_root_path, model, sandbox_mode, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    input.name,
    input.prompt,
    JSON.stringify(input.contextPaths),
    JSON.stringify(input.writablePaths),
    JSON.stringify([]),
    input.validationPrompt,
    input.cloneRootPath,
    input.model ?? null,
    input.sandboxMode,
  );
  return Number(result.lastInsertRowid);
}

export function updateSetupProfile(
  db: Database.Database,
  id: number,
  input: {
    name: string;
    prompt: string;
    contextPaths: string[];
    writablePaths: string[];
    validationPrompt: string;
    cloneRootPath: string;
    model?: string;
    sandboxMode: "workspace-write" | "danger-full-access";
  },
): boolean {
  const result = db.prepare(`
    UPDATE setup_profiles
    SET name = ?, prompt = ?, context_paths_json = ?, writable_paths_json = ?, validation_commands_json = ?, validation_prompt = ?, clone_root_path = ?, model = ?, sandbox_mode = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    input.name,
    input.prompt,
    JSON.stringify(input.contextPaths),
    JSON.stringify(input.writablePaths),
    JSON.stringify([]),
    input.validationPrompt,
    input.cloneRootPath,
    input.model ?? null,
    input.sandboxMode,
    id,
  );
  return result.changes > 0;
}

export function deleteSetupProfile(db: Database.Database, id: number): boolean {
  const result = db.prepare("DELETE FROM setup_profiles WHERE id = ?").run(id);
  return result.changes > 0;
}

export function createSetupRun(
  db: Database.Database,
  input: {
    targetType: SetupTargetType;
    targetLabel: string;
    repoId: number;
    issueId?: number;
    issueNumber?: number;
    issueTitle?: string;
    profileId?: number;
    prompt: string;
    contextPaths: string[];
    writablePaths: string[];
    validationPrompt: string;
    cloneRootPath: string;
    model?: string;
    sandboxMode: "workspace-write" | "danger-full-access";
  },
): number {
  const result = db.prepare(`
    INSERT INTO setup_runs (target_type, target_label, repo_id, issue_id, issue_number, issue_title, profile_id, status, prompt, context_paths_json, writable_paths_json, validation_commands_json, validation_prompt, clone_root_path, model, sandbox_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.targetType,
    input.targetLabel,
    input.repoId,
    input.issueId ?? null,
    input.issueNumber ?? null,
    input.issueTitle ?? null,
    input.profileId ?? null,
    input.prompt,
    JSON.stringify(input.contextPaths),
    JSON.stringify(input.writablePaths),
    JSON.stringify([]),
    input.validationPrompt,
    input.cloneRootPath,
    input.model ?? null,
    input.sandboxMode,
  );
  return Number(result.lastInsertRowid);
}

export function updateSetupRun(
  db: Database.Database,
  id: number,
  updates: {
    status?: SetupRunStatus;
    worktreePath?: string;
    stdoutPath?: string;
    stderrPath?: string;
    lastMessagePath?: string;
    diffPath?: string;
    summary?: string;
    changedFiles?: string[];
    violationFiles?: string[];
    error?: string;
    finishedAt?: string | null;
  },
): boolean {
  const result = db.prepare(`
    UPDATE setup_runs
    SET
      status = COALESCE(@status, status),
      worktree_path = COALESCE(@worktreePath, worktree_path),
      stdout_path = COALESCE(@stdoutPath, stdout_path),
      stderr_path = COALESCE(@stderrPath, stderr_path),
      last_message_path = COALESCE(@lastMessagePath, last_message_path),
      diff_path = COALESCE(@diffPath, diff_path),
      summary = COALESCE(@summary, summary),
      changed_files_json = COALESCE(@changedFilesJson, changed_files_json),
      violation_files_json = COALESCE(@violationFilesJson, violation_files_json),
      error = COALESCE(@error, error),
      finished_at = CASE
        WHEN @finishedAtIsSet = 1 THEN @finishedAt
        ELSE finished_at
      END
    WHERE id = @id
  `).run({
    id,
    status: updates.status ?? null,
    worktreePath: updates.worktreePath ?? null,
    stdoutPath: updates.stdoutPath ?? null,
    stderrPath: updates.stderrPath ?? null,
    lastMessagePath: updates.lastMessagePath ?? null,
    diffPath: updates.diffPath ?? null,
    summary: updates.summary ?? null,
    changedFilesJson: updates.changedFiles ? JSON.stringify(updates.changedFiles) : null,
    violationFilesJson: updates.violationFiles ? JSON.stringify(updates.violationFiles) : null,
    error: updates.error ?? null,
    finishedAt: updates.finishedAt ?? null,
    finishedAtIsSet: Object.prototype.hasOwnProperty.call(updates, "finishedAt") ? 1 : 0,
  });
  return result.changes > 0;
}

export function getSetupRuns(
  db: Database.Database,
  opts: { repoId?: number; issueId?: number; limit?: number; offset?: number } = {},
): { rows: SetupRunRecord[]; total: number } {
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;
  const whereParts: string[] = [];
  const params: Record<string, unknown> = { limit, offset };
  if (typeof opts.repoId === "number") {
    whereParts.push("sr.repo_id = @repoId");
    params.repoId = opts.repoId;
  }
  if (typeof opts.issueId === "number") {
    whereParts.push("sr.issue_id = @issueId");
    params.issueId = opts.issueId;
  }
  const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
  const total = (db.prepare(`
    SELECT COUNT(*) as cnt
    FROM setup_runs sr
    ${where}
  `).get(params) as any).cnt;
  const rows = db.prepare(`
    SELECT
      sr.*,
      r.full_name as repo_full_name,
      sp.name as profile_name
    FROM setup_runs sr
    JOIN repos r ON r.id = sr.repo_id
    LEFT JOIN setup_profiles sp ON sp.id = sr.profile_id
    ${where}
    ORDER BY sr.started_at DESC, sr.id DESC
    LIMIT @limit OFFSET @offset
  `).all(params);
  return { rows: rows.map((row) => mapSetupRunRow(row)), total };
}

export function getSetupRunById(db: Database.Database, id: number): SetupRunRecord | undefined {
  const row = db.prepare(`
    SELECT
      sr.*,
      r.full_name as repo_full_name,
      sp.name as profile_name
    FROM setup_runs sr
    JOIN repos r ON r.id = sr.repo_id
    LEFT JOIN setup_profiles sp ON sp.id = sr.profile_id
    WHERE sr.id = ?
  `).get(id);
  return row ? mapSetupRunRow(row) : undefined;
}

/* ------------------------------------------------------------------ */
/* Pull Requests                                                       */
/* ------------------------------------------------------------------ */

export function upsertPullRequest(db: Database.Database, repoId: number, pr: { number: number; url: string; title: string; body: string; mergedAt?: string | null; changedFilesCount?: number; labels: string[]; baseRefName: string; baseRefOid: string; headRefOid: string }): number {
  db.prepare(`
    INSERT INTO pull_requests (repo_id, number, url, title, body, merged_at, changed_files, labels, base_ref_name, base_ref_oid, head_ref_oid)
    VALUES (@repoId, @number, @url, @title, @body, @mergedAt, @changedFiles, @labels, @baseRefName, @baseRefOid, @headRefOid)
    ON CONFLICT(repo_id, number) DO UPDATE SET
      title = @title, body = @body, merged_at = @mergedAt, changed_files = @changedFiles, labels = @labels
  `).run({
    repoId,
    number: pr.number,
    url: pr.url,
    title: pr.title,
    body: pr.body,
    mergedAt: pr.mergedAt ?? null,
    changedFiles: pr.changedFilesCount ?? null,
    labels: JSON.stringify(pr.labels),
    baseRefName: pr.baseRefName,
    baseRefOid: pr.baseRefOid,
    headRefOid: pr.headRefOid,
  });
  const row = db.prepare("SELECT id FROM pull_requests WHERE repo_id = ? AND number = ?").get(repoId, pr.number) as { id: number };
  return row.id;
}

/* ------------------------------------------------------------------ */
/* Issues                                                              */
/* ------------------------------------------------------------------ */

export function upsertIssue(db: Database.Database, prId: number, issue: IssueRef): void {
  db.prepare(`
    INSERT INTO issues (pr_id, owner, repo, number, url, title, body, state, link_type)
    VALUES (@prId, @owner, @repo, @number, @url, @title, @body, @state, @linkType)
    ON CONFLICT(pr_id, owner, repo, number) DO UPDATE SET
      title = @title, body = @body, state = @state, link_type = @linkType
  `).run({
    prId,
    owner: issue.owner,
    repo: issue.repo,
    number: issue.number,
    url: issue.url ?? null,
    title: issue.title ?? null,
    body: issue.body ?? null,
    state: issue.state ?? null,
    linkType: issue.linkType,
  });
}

/* ------------------------------------------------------------------ */
/* Scans                                                               */
/* ------------------------------------------------------------------ */

export function createScan(db: Database.Database, configJson: string): number {
  const result = db.prepare("INSERT INTO scans (config_json, status) VALUES (?, 'running')").run(configJson);
  return Number(result.lastInsertRowid);
}

export function finishScan(
  db: Database.Database,
  scanId: number,
  status: ScanStatus,
  totalDurationMs: number,
  acceptedCount: number,
  rejectedCount: number,
  performanceMetrics?: ScanPerformanceMetrics,
): void {
  db.prepare(`
    UPDATE scans SET status = ?, finished_at = datetime('now'), total_duration_ms = ?, accepted_count = ?, rejected_count = ?, metrics_json = ?
    WHERE id = ?
  `).run(
    status,
    totalDurationMs,
    acceptedCount,
    rejectedCount,
    performanceMetrics ? JSON.stringify(performanceMetrics) : null,
    scanId,
  );
}

export function getScans(db: Database.Database, limit = 50, offset = 0): { rows: any[]; total: number } {
  const total = (db.prepare("SELECT COUNT(*) as cnt FROM scans").get() as any).cnt;
  const rows = db.prepare("SELECT * FROM scans ORDER BY started_at DESC LIMIT ? OFFSET ?").all(limit, offset);
  return { rows, total };
}

export function getScanById(db: Database.Database, id: number): any {
  const scan = db.prepare("SELECT * FROM scans WHERE id = ?").get(id);
  if (!scan) return undefined;
  const candidates = db.prepare(`
    SELECT sc.*, r.full_name as repo_full_name, r.stars as repo_stars
    FROM scan_candidates sc
    JOIN repos r ON r.id = sc.repo_id
    WHERE sc.scan_id = ?
    ORDER BY sc.accepted DESC, sc.created_at ASC
  `).all(id);
  return { ...scan as any, candidates };
}

/* ------------------------------------------------------------------ */
/* Scan candidates                                                     */
/* ------------------------------------------------------------------ */

export function insertScanCandidate(
  db: Database.Database,
  scanId: number,
  repoId: number,
  prId: number | null,
  candidate: CandidateReport,
): number {
  const result = db.prepare(`
    INSERT INTO scan_candidates (scan_id, repo_id, pr_id, accepted, pre_fix_sha, rejection_reasons, tests_unable_to_run, tests_unable_to_run_reason, timings_json, details_json)
    VALUES (@scanId, @repoId, @prId, @accepted, @preFixSha, @rejectionReasons, @testsUnableToRun, @testsUnableToRunReason, @timingsJson, @detailsJson)
  `).run({
    scanId,
    repoId,
    prId,
    accepted: candidate.accepted ? 1 : 0,
    preFixSha: candidate.preFixSha || null,
    rejectionReasons: JSON.stringify(candidate.rejectionReasons),
    testsUnableToRun: candidate.testsUnableToRun ? 1 : 0,
    testsUnableToRunReason: candidate.testsUnableToRunReason ?? null,
    timingsJson: JSON.stringify(candidate.timings),
    detailsJson: JSON.stringify({
      basicFilterPassed: candidate.basicFilterPassed,
      screening: candidate.screening,
      analysis: candidate.analysis,
      testPlan: candidate.testPlan,
      execution: candidate.execution,
    }),
  });
  return Number(result.lastInsertRowid);
}

/* ------------------------------------------------------------------ */
/* Stats / Issues listing                                              */
/* ------------------------------------------------------------------ */

export function getStats(db: Database.Database): any {
  const repos = (db.prepare("SELECT COUNT(*) as cnt FROM repos").get() as any).cnt;
  const prs = (db.prepare("SELECT COUNT(*) as cnt FROM pull_requests").get() as any).cnt;
  const issues = (db.prepare("SELECT COUNT(*) as cnt FROM issues").get() as any).cnt;
  const scans = (db.prepare("SELECT COUNT(*) as cnt FROM scans").get() as any).cnt;
  const dedupedCandidateStats = db.prepare(`
    WITH ranked_candidates AS (
      SELECT
        sc.*,
        ROW_NUMBER() OVER (
          PARTITION BY sc.repo_id, COALESCE(sc.pr_id, -sc.id)
          ORDER BY sc.id DESC
        ) AS row_rank
      FROM scan_candidates sc
    )
    SELECT
      COALESCE(SUM(CASE WHEN accepted = 1 THEN 1 ELSE 0 END), 0) as accepted,
      COALESCE(SUM(CASE WHEN accepted = 0 THEN 1 ELSE 0 END), 0) as rejected,
      COALESCE(SUM(CASE WHEN tests_unable_to_run = 1 THEN 1 ELSE 0 END), 0) as tests_unable_to_run
    FROM ranked_candidates
    WHERE row_rank = 1
  `).get() as { accepted: number; rejected: number; tests_unable_to_run: number };
  const accepted = dedupedCandidateStats.accepted;
  const rejected = dedupedCandidateStats.rejected;
  const testsUnableToRun = dedupedCandidateStats.tests_unable_to_run;
  const lastScan = db.prepare("SELECT * FROM scans ORDER BY started_at DESC LIMIT 1").get();
  return { repos, prs, issues, scans, accepted, rejected, testsUnableToRun, lastScan };
}

export function getIssues(db: Database.Database, opts: { limit?: number; offset?: number } = {}): { rows: any[]; total: number } {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const total = (db.prepare("SELECT COUNT(*) as cnt FROM issues").get() as any).cnt;
  const rows = db.prepare(`
    SELECT
      i.*,
      pr.number as pr_number,
      pr.title as pr_title,
      pr.url as pr_url,
      r.id as repo_id,
      r.full_name as repo_full_name,
      r.url as repo_url,
      r.stars as repo_stars,
      r.primary_language as repo_primary_language,
      r.description as repo_description
    FROM issues i
    JOIN pull_requests pr ON pr.id = i.pr_id
    JOIN repos r ON r.id = pr.repo_id
    ORDER BY i.created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
  return { rows, total };
}

export function getIssueRecordById(db: Database.Database, id: number): any {
  return db.prepare(`
    SELECT
      i.*,
      pr.id as pr_id,
      pr.number as pr_number,
      pr.title as pr_title,
      pr.url as pr_url,
      pr.base_ref_name as pr_base_ref_name,
      pr.base_ref_oid as pr_base_ref_oid,
      r.id as repo_id,
      r.full_name as repo_full_name,
      r.owner as repo_owner,
      r.name as repo_name,
      r.url as repo_url,
      r.stars as repo_stars,
      r.primary_language as repo_primary_language,
      r.default_branch as repo_default_branch,
      r.description as repo_description,
      r.is_archived as repo_is_archived,
      r.pushed_at as repo_pushed_at,
      r.disk_usage_kb as repo_disk_usage_kb
    FROM issues i
    JOIN pull_requests pr ON pr.id = i.pr_id
    JOIN repos r ON r.id = pr.repo_id
    WHERE i.id = ?
  `).get(id);
}

export function getTestsUnableCandidates(db: Database.Database, limit = 50): { rows: any[]; total: number } {
  const total = (db.prepare("SELECT COUNT(*) as cnt FROM scan_candidates WHERE tests_unable_to_run = 1").get() as any).cnt;
  const rows = db.prepare(`
    SELECT
      sc.*,
      s.id as scan_id,
      s.status as scan_status,
      s.started_at as scan_started_at,
      r.full_name as repo_full_name,
      r.stars as repo_stars,
      pr.number as pr_number,
      pr.title as pr_title,
      pr.url as pr_url
    FROM scan_candidates sc
    JOIN scans s ON s.id = sc.scan_id
    JOIN repos r ON r.id = sc.repo_id
    LEFT JOIN pull_requests pr ON pr.id = sc.pr_id
    WHERE sc.tests_unable_to_run = 1
    ORDER BY sc.created_at DESC
    LIMIT ?
  `).all(limit);
  return { rows, total };
}

export function getAcceptedCandidates(
  db: Database.Database,
  opts: { limit?: number; offset?: number; reviewStatus?: string } = {},
): { rows: any[]; total: number } {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const reviewStatus = opts.reviewStatus === "reviewing"
    || opts.reviewStatus === "approved"
    || opts.reviewStatus === "follow_up"
    || opts.reviewStatus === "new"
    ? opts.reviewStatus
    : "all";
  const params = {
    reviewStatus,
    limit,
    offset,
  };
  const rankedCandidatesCte = `
    WITH ranked_candidates AS (
      SELECT
        sc.*,
        ROW_NUMBER() OVER (
          PARTITION BY sc.repo_id, COALESCE(sc.pr_id, -sc.id)
          ORDER BY sc.id DESC
        ) AS row_rank
      FROM scan_candidates sc
    )
  `;
  const rankedWhere = [
    "rc.row_rank = 1",
    "rc.accepted = 1",
    reviewStatus === "all"
      ? ""
      : "COALESCE(NULLIF(json_extract(rc.details_json, '$.reviewQueue.status'), ''), 'new') = @reviewStatus",
  ].filter(Boolean).join(" AND ");

  const total = (db.prepare(`${rankedCandidatesCte} SELECT COUNT(*) as cnt FROM ranked_candidates rc WHERE ${rankedWhere}`).get(params) as any).cnt;
  const rows = db.prepare(`
    ${rankedCandidatesCte}
    SELECT
      rc.*,
      s.id as scan_id,
      s.status as scan_status,
      s.started_at as scan_started_at,
      r.full_name as repo_full_name,
      r.url as repo_url,
      r.stars as repo_stars,
      r.primary_language as repo_primary_language,
      pr.number as pr_number,
      pr.title as pr_title,
      pr.url as pr_url,
      pr.merged_at as pr_merged_at
    FROM ranked_candidates rc
    JOIN scans s ON s.id = rc.scan_id
    JOIN repos r ON r.id = rc.repo_id
    LEFT JOIN pull_requests pr ON pr.id = rc.pr_id
    WHERE ${rankedWhere}
    ORDER BY rc.created_at DESC, rc.id DESC
    LIMIT @limit OFFSET @offset
  `).all(params);
  return { rows, total };
}

export function getIssuesForCandidate(db: Database.Database, candidateId: number): any[] {
  return db.prepare(`
    SELECT
      i.*,
      (i.owner || '/' || i.repo) as issue_repo_full_name
    FROM issues i
    JOIN scan_candidates sc ON sc.pr_id = i.pr_id
    WHERE sc.id = ?
    ORDER BY i.created_at DESC
  `).all(candidateId);
}

export function getIssuesForCandidateIds(db: Database.Database, candidateIds: number[]): Record<number, any[]> {
  if (!candidateIds.length) {
    return {};
  }
  const placeholders = candidateIds.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT
      sc.id as candidate_id,
      i.*,
      (i.owner || '/' || i.repo) as issue_repo_full_name
    FROM issues i
    JOIN scan_candidates sc ON sc.pr_id = i.pr_id
    WHERE sc.id IN (${placeholders})
    ORDER BY i.created_at DESC
  `).all(...candidateIds) as Array<Record<string, unknown> & { candidate_id: number }>;

  const grouped: Record<number, any[]> = {};
  for (const row of rows) {
    const candidateId = Number(row.candidate_id);
    if (!grouped[candidateId]) {
      grouped[candidateId] = [];
    }
    grouped[candidateId].push(row);
  }
  return grouped;
}

export function getScanCandidateById(db: Database.Database, id: number): any {
  return db.prepare(`
    SELECT
      sc.*,
      s.id as scan_id,
      s.status as scan_status,
      r.full_name as repo_full_name,
      r.owner as repo_owner,
      r.name as repo_name,
      r.url as repo_url,
      r.stars as repo_stars,
      r.primary_language as repo_primary_language,
      r.default_branch as repo_default_branch,
      r.is_archived as repo_is_archived,
      r.pushed_at as repo_pushed_at,
      r.disk_usage_kb as repo_disk_usage_kb,
      r.description as repo_description,
      pr.number as pr_number,
      pr.title as pr_title,
      pr.url as pr_url
    FROM scan_candidates sc
    JOIN scans s ON s.id = sc.scan_id
    JOIN repos r ON r.id = sc.repo_id
    LEFT JOIN pull_requests pr ON pr.id = sc.pr_id
    WHERE sc.id = ?
  `).get(id);
}

export function updateScanCandidateState(
  db: Database.Database,
  candidateId: number,
  updates: {
    accepted: boolean;
    rejectionReasons: string[];
    testsUnableToRun: boolean;
    testsUnableToRunReason?: string;
    detailsJson: string;
  },
): void {
  db.prepare(`
    UPDATE scan_candidates
    SET accepted = ?, rejection_reasons = ?, tests_unable_to_run = ?, tests_unable_to_run_reason = ?, details_json = ?
    WHERE id = ?
  `).run(
    updates.accepted ? 1 : 0,
    JSON.stringify(updates.rejectionReasons),
    updates.testsUnableToRun ? 1 : 0,
    updates.testsUnableToRunReason ?? null,
    updates.detailsJson,
    candidateId,
  );
}

export function refreshScanCounts(db: Database.Database, scanId: number): void {
  const acceptedCount = (db.prepare("SELECT COUNT(*) as cnt FROM scan_candidates WHERE scan_id = ? AND accepted = 1").get(scanId) as any).cnt;
  const rejectedCount = (db.prepare("SELECT COUNT(*) as cnt FROM scan_candidates WHERE scan_id = ? AND accepted = 0").get(scanId) as any).cnt;
  db.prepare("UPDATE scans SET accepted_count = ?, rejected_count = ? WHERE id = ?").run(acceptedCount, rejectedCount, scanId);
}
