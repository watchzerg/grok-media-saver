import type { SQL } from "bun";

type Column = readonly [
  name: string,
  type: string,
  nullable: boolean,
  defaultValue: string | null,
];
type Constraint = readonly [name: string, definition: string];
type Table = {
  name: string;
  columns: readonly Column[];
  constraints: readonly Constraint[];
  create: string;
};

const schema: readonly Table[] = [
  {
    name: "runs",
    columns: [
      ["id", "uuid", false, null],
      ["command", "text", false, null],
      ["target_post_id", "text", true, null],
      ["started_at", "timestamptz", false, null],
      ["finished_at", "timestamptz", true, null],
      ["outcome", "text", true, null],
      ["summary", "jsonb", true, null],
    ],
    constraints: [
      ["runs_pkey", "PRIMARY KEY (id)"],
      [
        "runs_command_check",
        "CHECK (command = ANY (ARRAY['save-first-page'::text, 'save-post'::text, 'retry'::text, 'archive-post'::text]))",
      ],
    ],
    create: `CREATE TABLE runs (
      id uuid PRIMARY KEY,
      command text NOT NULL CONSTRAINT runs_command_check
        CHECK (command IN ('save-first-page', 'save-post', 'retry', 'archive-post')),
      target_post_id text,
      started_at timestamptz NOT NULL,
      finished_at timestamptz,
      outcome text,
      summary jsonb
    )`,
  },
  {
    name: "post_work",
    columns: [
      ["post_id", "text", false, null],
      ["goal", "text", false, "'save'::text"],
      ["archive_settled", "bool", false, "false"],
      ["removal_state", "text", false, "'none'::text"],
      ["deletion_media_version_id", "uuid", true, null],
      ["status", "text", false, null],
      ["last_run_id", "uuid", true, null],
      ["selected_key", "text", true, null],
      ["quality", "text", true, null],
      ["mime_type", "text", true, null],
      ["source_mime_type", "text", true, null],
      ["expected_bytes", "int8", true, null],
      ["saved_media_version_id", "uuid", true, null],
      ["last_error", "text", true, null],
      ["publish_temp_name", "text", true, null],
      ["publish_relative_path", "text", true, null],
      ["publish_expected_bytes", "int8", true, null],
      ["publish_sha256", "text", true, null],
    ],
    constraints: [
      ["post_work_pkey", "PRIMARY KEY (post_id)"],
      [
        "post_work_removal_state_check",
        "CHECK (removal_state = ANY (ARRAY['none'::text, 'pending'::text, 'removed'::text]))",
      ],
      [
        "post_work_deletion_binding_check",
        "CHECK (removal_state = 'none'::text AND deletion_media_version_id IS NULL OR removal_state <> 'none'::text AND deletion_media_version_id IS NOT NULL AND goal = 'archive'::text)",
      ],
      [
        "post_work_deletion_media_version_fkey",
        "FOREIGN KEY (post_id, deletion_media_version_id) REFERENCES media_versions(post_id, id)",
      ],
      [
        "post_work_goal_check",
        "CHECK (goal = ANY (ARRAY['save'::text, 'archive'::text]))",
      ],
      [
        "post_work_archive_settled_check",
        "CHECK (NOT archive_settled OR goal = 'archive'::text AND removal_state = 'removed'::text AND status = 'saved'::text AND saved_media_version_id IS NOT NULL AND saved_media_version_id = deletion_media_version_id AND publish_sha256 IS NULL)",
      ],
      [
        "post_work_status_check",
        "CHECK (status = ANY (ARRAY['pending'::text, 'finalizing'::text, 'saved'::text, 'failed'::text]))",
      ],
      [
        "post_work_last_run_id_fkey",
        "FOREIGN KEY (last_run_id) REFERENCES runs(id)",
      ],
      [
        "post_work_publish_intent_check",
        "CHECK ((publish_temp_name IS NULL) = (publish_relative_path IS NULL) AND (publish_temp_name IS NULL) = (publish_expected_bytes IS NULL) AND (publish_temp_name IS NULL) = (publish_sha256 IS NULL))",
      ],
      [
        "post_work_saved_media_version_fkey",
        "FOREIGN KEY (post_id, saved_media_version_id) REFERENCES media_versions(post_id, id)",
      ],
    ],
    create: `CREATE TABLE post_work (
      post_id text PRIMARY KEY,
      goal text NOT NULL DEFAULT 'save' CONSTRAINT post_work_goal_check
        CHECK (goal IN ('save', 'archive')),
      archive_settled boolean NOT NULL DEFAULT false,
      removal_state text NOT NULL DEFAULT 'none' CONSTRAINT post_work_removal_state_check
        CHECK (removal_state IN ('none', 'pending', 'removed')),
      deletion_media_version_id uuid,
      CONSTRAINT post_work_deletion_binding_check CHECK (
        (removal_state = 'none' AND deletion_media_version_id IS NULL) OR
        (removal_state <> 'none' AND deletion_media_version_id IS NOT NULL AND goal = 'archive')),
      CONSTRAINT post_work_archive_settled_check CHECK (NOT archive_settled OR (goal = 'archive' AND removal_state = 'removed' AND status = 'saved' AND saved_media_version_id IS NOT NULL AND saved_media_version_id = deletion_media_version_id AND publish_sha256 IS NULL)),
      status text NOT NULL CONSTRAINT post_work_status_check
        CHECK (status IN ('pending', 'finalizing', 'saved', 'failed')),
      last_run_id uuid REFERENCES runs(id),
      selected_key text,
      quality text,
      mime_type text,
      source_mime_type text,
      expected_bytes bigint,
      saved_media_version_id uuid,
      last_error text,
      publish_temp_name text,
      publish_relative_path text,
      publish_expected_bytes bigint,
      publish_sha256 text,
      CONSTRAINT post_work_publish_intent_check
        CHECK ((publish_temp_name IS NULL) = (publish_relative_path IS NULL)
        AND (publish_temp_name IS NULL) = (publish_expected_bytes IS NULL)
        AND (publish_temp_name IS NULL) = (publish_sha256 IS NULL))
    )`,
  },
  {
    name: "media_versions",
    columns: [
      ["id", "uuid", false, null],
      ["post_id", "text", false, null],
      ["sha256", "text", false, null],
      ["byte_count", "int8", false, null],
      ["mime_type", "text", false, null],
      ["relative_path", "text", false, null],
      ["saved_at", "timestamptz", false, null],
    ],
    constraints: [
      ["media_versions_pkey", "PRIMARY KEY (id)"],
      ["media_versions_post_id_id_key", "UNIQUE (post_id, id)"],
      ["media_versions_post_id_sha256_key", "UNIQUE (post_id, sha256)"],
      [
        "media_versions_post_id_fkey",
        "FOREIGN KEY (post_id) REFERENCES post_work(post_id)",
      ],
      ["media_versions_byte_count_check", "CHECK (byte_count >= 0)"],
    ],
    create: `CREATE TABLE media_versions (
      id uuid PRIMARY KEY,
      post_id text NOT NULL REFERENCES post_work(post_id),
      sha256 text NOT NULL,
      byte_count bigint NOT NULL CONSTRAINT media_versions_byte_count_check
        CHECK (byte_count >= 0),
      mime_type text NOT NULL,
      relative_path text NOT NULL,
      saved_at timestamptz NOT NULL,
      UNIQUE (post_id, id),
      UNIQUE (post_id, sha256)
    )`,
  },
];

export async function initializeSchema(sql: SQL): Promise<void> {
  await sql.begin(async (tx) => {
    await assertExistingTablesMatch(tx, true);
    for (const table of schema) {
      const [exists] = await tx<{ exists: boolean }[]>`
        SELECT to_regclass(${`public.${table.name}`}) IS NOT NULL AS exists
      `;
      if (!exists.exists) await tx.unsafe(table.create);
    }
    const [savedVersionConstraint] = await tx<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'post_work_saved_media_version_fkey'
          AND conrelid = 'public.post_work'::regclass
      ) AS exists
    `;
    if (!savedVersionConstraint.exists) {
      await tx.unsafe(`
        ALTER TABLE post_work
        ADD CONSTRAINT post_work_saved_media_version_fkey
        FOREIGN KEY (post_id, saved_media_version_id)
        REFERENCES media_versions(post_id, id)
      `);
    }
    const [deletionConstraint] = await tx<{ exists: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'post_work_deletion_media_version_fkey'
        AND conrelid = 'public.post_work'::regclass) AS exists
    `;
    if (!deletionConstraint.exists)
      await tx.unsafe(`ALTER TABLE post_work ADD CONSTRAINT post_work_deletion_media_version_fkey
      FOREIGN KEY (post_id, deletion_media_version_id) REFERENCES media_versions(post_id, id)`);
    await assertExistingTablesMatch(tx, false);
  });
}

export async function verifySchema(sql: SQL): Promise<void> {
  await assertExistingTablesMatch(sql, false);
}

async function assertExistingTablesMatch(
  sql: SQL,
  allowMissing: boolean,
): Promise<void> {
  for (const table of schema) {
    const [exists] = await sql<{ exists: boolean }[]>`
      SELECT to_regclass(${`public.${table.name}`}) IS NOT NULL AS exists
    `;
    if (!exists.exists) {
      if (allowMissing) continue;
      throw new Error("数据库结构不完整。请运行 db init。");
    }
    const columns = await sql<
      {
        column_name: string;
        udt_name: string;
        is_nullable: string;
        column_default: string | null;
      }[]
    >`
      SELECT column_name, udt_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table.name}
      ORDER BY ordinal_position
    `;
    const actualColumns = columns.map(
      ({ column_name, udt_name, is_nullable, column_default }) =>
        [column_name, udt_name, is_nullable === "YES", column_default] as const,
    );
    if (JSON.stringify(actualColumns) !== JSON.stringify(table.columns))
      throw new Error("数据库结构与当前版本不一致。");

    const constraints = await sql<
      { conname: string; definition: string; contype: string }[]
    >`
      SELECT c.conname, pg_get_constraintdef(c.oid, true) AS definition, c.contype
      FROM pg_constraint c
      JOIN pg_class r ON r.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE n.nspname = 'public' AND r.relname = ${table.name} AND c.contype <> 'n'
      ORDER BY c.conname
    `;
    const actualConstraints = constraints.map(
      ({ conname, definition }) => [conname, definition] as const,
    );
    const expectedConstraints = table.constraints;
    if (
      actualConstraints.length !== expectedConstraints.length ||
      expectedConstraints.some(([name, definition]) =>
        actualConstraints.every(
          ([actualName, actualDefinition]) =>
            actualName !== name || actualDefinition !== definition,
        ),
      )
    )
      throw new Error("数据库结构与当前版本不一致。");

    const [indexCounts] = await sql<
      { all_indexes: number; constraint_indexes: number }[]
    >`
      SELECT
        (SELECT count(*)::integer FROM pg_index i
          JOIN pg_class r ON r.oid = i.indrelid
          JOIN pg_namespace n ON n.oid = r.relnamespace
          WHERE n.nspname = 'public' AND r.relname = ${table.name}) AS all_indexes,
        (SELECT count(*)::integer FROM pg_index i
          JOIN pg_class r ON r.oid = i.indrelid
          JOIN pg_namespace n ON n.oid = r.relnamespace
          JOIN pg_constraint c ON c.conindid = i.indexrelid AND c.conrelid = r.oid
          WHERE n.nspname = 'public' AND r.relname = ${table.name}) AS constraint_indexes
    `;
    if (indexCounts.all_indexes !== indexCounts.constraint_indexes)
      throw new Error("数据库结构与当前版本不一致。");
  }
}
