import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { toDate } from "date-fns";
import { maxTime } from "date-fns/constants";

import {
    migrationsDirectory,
    openFreshMigratedDatabase,
} from "../../test/support/freshDatabase.ts";
import {
    applyVerifiedMigrations,
    planMigrationAppliedAtValues,
} from "./applyVerifiedMigrations.ts";
import { loadVerifiedMigrations } from "./loadVerifiedMigrations.ts";

test("plans a strictly increasing timestamp for every pending migration", () => {
    const appliedAtValues = planMigrationAppliedAtValues(1000, 3, 997);

    expect(appliedAtValues).toEqual([998, 999, 1000]);
    expect(Object.isFrozen(appliedAtValues)).toBeTrue();
});

test("rejects clock rollback, future history, and a same-millisecond append", () => {
    expect(() => planMigrationAppliedAtValues(999, 0, 1000)).toThrow(
        "Database migration history is newer than the application clock"
    );
    expect(() => planMigrationAppliedAtValues(999, 1, 1000)).toThrow(
        "Database migration history is newer than the application clock"
    );
    expect(() => planMigrationAppliedAtValues(1000, 1, 1000)).toThrow(
        "Migration appliedAt must advance beyond stored migration history"
    );
    expect(planMigrationAppliedAtValues(1000, 0, 1000)).toEqual([]);
});

test("keeps multiple pending timestamps out of the future and fails atomically at epoch", () => {
    expect(planMigrationAppliedAtValues(maxTime, 2)).toEqual([maxTime - 1, maxTime]);
    expect(() => planMigrationAppliedAtValues(0, 2)).toThrow(
        "Migration appliedAt must be valid Date milliseconds"
    );
});

test("rejects an invalid migration timestamp without changing the database", async () => {
    const migrations = await loadVerifiedMigrations({ directory: migrationsDirectory });
    const database = new Database(":memory:", { strict: true });

    try {
        database.run("PRAGMA foreign_keys = ON");
        expect(() =>
            applyVerifiedMigrations(database, migrations, {
                appliedAt: toDate(Number.NaN),
                releaseId: "1".repeat(40),
            })
        ).toThrow("Migration appliedAt must be valid Date milliseconds");
        expect(
            database
                .query<{ name: string }, []>(`
                    SELECT name
                    FROM sqlite_schema
                    WHERE name NOT GLOB 'sqlite_*'
                `)
                .all()
        ).toEqual([]);
    } finally {
        database.close(true);
    }
});

test("rejects future stored history without changing an already-current database", async () => {
    const migrations = await loadVerifiedMigrations({ directory: migrationsDirectory });
    const database = await openFreshMigratedDatabase();

    try {
        const before = database.sqlite
            .query<
                { appliedAt: number; checksum: string; id: string; releaseId: string },
                []
            >(`
                SELECT
                    applied_at AS appliedAt,
                    checksum,
                    id,
                    release_id AS releaseId
                FROM schema_migrations
            `)
            .all();
        const storedAppliedAt = before[0]?.appliedAt;
        if (storedAppliedAt === undefined) {
            throw new Error("Expected one applied migration");
        }

        expect(() =>
            applyVerifiedMigrations(database.sqlite, migrations, {
                appliedAt: new Date(storedAppliedAt - 1),
                releaseId: "1".repeat(40),
            })
        ).toThrow("Database migration history is newer than the application clock");
        expect(
            database.sqlite
                .query<
                    {
                        appliedAt: number;
                        checksum: string;
                        id: string;
                        releaseId: string;
                    },
                    []
                >(`
                    SELECT
                        applied_at AS appliedAt,
                        checksum,
                        id,
                        release_id AS releaseId
                    FROM schema_migrations
                `)
                .all()
        ).toEqual(before);
    } finally {
        database.sqlite.close(true);
    }
});
