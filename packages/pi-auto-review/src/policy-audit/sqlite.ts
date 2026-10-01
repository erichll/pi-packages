type Statement = {
  run(...params: unknown[]): { changes: number | bigint };
  // Node returns undefined for a missing row; Bun returns null.
  get(...params: unknown[]): Record<string, unknown> | null | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
};

export type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
};

export type SqliteModule = {
  DatabaseSync: new (path: string, options?: Record<string, unknown>) => SqliteDatabase;
};

type BunDatabase = Omit<SqliteDatabase, "prepare"> & {
  query(sql: string): Statement;
};

/** Load the host's built-in SQLite lazily, including inside Bun-compiled Pi. */
export async function loadSqlite(): Promise<SqliteModule> {
  if (process.versions.bun) {
    // A runtime specifier avoids requiring Bun's ambient types in Node builds.
    const specifier = "bun:sqlite";
    const sqlite = await import(specifier) as {
      Database: new (path: string, options?: Record<string, unknown>) => BunDatabase;
    };
    return {
      DatabaseSync: class implements SqliteDatabase {
        private readonly database: BunDatabase;

        constructor(path: string, options?: Record<string, unknown>) {
          this.database = new sqlite.Database(path, options);
        }

        exec(sql: string): void {
          this.database.exec(sql);
        }

        prepare(sql: string): Statement {
          // Bun finalizes cached queries on close. Uncached prepare() statements
          // can outlive the connection, retaining locks and delaying checkpoints.
          return this.database.query(sql);
        }

        close(): void {
          this.database.close();
        }
      },
    };
  }
  return import("node:sqlite") as Promise<SqliteModule>;
}
