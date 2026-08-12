import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    observeDevelopmentMigrationIdentity,
    readDevelopmentMigrationIdentity,
} from "./developmentMigrationIdentity.ts";

const migrationId = "20260812000000_development-identity-test";

function sha256(contents: string): string {
    return new Bun.CryptoHasher("sha256").update(contents).digest("hex");
}

function manifestSource(
    migrationSql: string,
    snapshot: string,
    revisionComment = ""
): string {
    return `/** Test migration manifest. */
export interface MigrationManifestEntry {
    readonly id: string;
    readonly migrationSha256: string;
    readonly snapshotSha256: string;
}

${revisionComment}
export const migrationManifest = Object.freeze<readonly MigrationManifestEntry[]>([
    Object.freeze({
        id: "${migrationId}",
        migrationSha256: "${sha256(migrationSql)}",
        snapshotSha256: "${sha256(snapshot)}",
    }),
]);
`;
}

async function writeMigrationFixture(
    repositoryRoot: string,
    migrationSql: string,
    snapshot: string,
    revisionComment = ""
): Promise<void> {
    const migrationRoot = path.join(repositoryRoot, "migrations", migrationId);
    const manifestRoot = path.join(repositoryRoot, "src", "shared");
    await Promise.all([
        mkdir(migrationRoot, { recursive: true }),
        mkdir(manifestRoot, { recursive: true }),
    ]);
    // Create these in reverse inventory order to prove directory enumeration order is irrelevant.
    await writeFile(path.join(migrationRoot, "snapshot.json"), snapshot, "utf8");
    await writeFile(path.join(migrationRoot, "migration.sql"), migrationSql, "utf8");
    await writeFile(
        path.join(manifestRoot, "databaseMigrationManifest.ts"),
        manifestSource(migrationSql, snapshot, revisionComment),
        "utf8"
    );
}

async function withMigrationFixture(
    task: (repositoryRoot: string) => Promise<void>
): Promise<void> {
    const repositoryRoot = await mkdtemp(
        path.join(tmpdir(), "mira-development-migration-identity-")
    );
    try {
        await writeMigrationFixture(
            repositoryRoot,
            "CREATE TABLE identity_one (id INTEGER PRIMARY KEY);\n",
            '{"version":1}\n'
        );
        await task(repositoryRoot);
    } finally {
        await rm(repositoryRoot, { force: true, recursive: true });
    }
}

describe("development migration identity", () => {
    test.each([
        {
            label: "migration SQL",
            migrationSql: "CREATE TABLE identity_two (id INTEGER PRIMARY KEY);\n",
            revisionComment: "",
            snapshot: '{"version":1}\n',
        },
        {
            label: "migration snapshot",
            migrationSql: "CREATE TABLE identity_one (id INTEGER PRIMARY KEY);\n",
            revisionComment: "",
            snapshot: '{"version":2}\n',
        },
    ])("changes when $label changes", async (update) => {
        await withMigrationFixture(async (repositoryRoot) => {
            const initial = await readDevelopmentMigrationIdentity(repositoryRoot);
            await writeMigrationFixture(
                repositoryRoot,
                update.migrationSql,
                update.snapshot,
                update.revisionComment
            );

            const changed = await readDevelopmentMigrationIdentity(repositoryRoot);

            expect(changed).toMatch(/^[a-f\d]{64}$/u);
            expect(changed).not.toBe(initial);
        });
    });

    test("ignores comments and formatting outside the semantic manifest body", async () => {
        await withMigrationFixture(async (repositoryRoot) => {
            const initial = await readDevelopmentMigrationIdentity(repositoryRoot);
            await writeMigrationFixture(
                repositoryRoot,
                "CREATE TABLE identity_one (id INTEGER PRIMARY KEY);\n",
                '{"version":1}\n',
                "// semantic-neutral manifest formatting revision"
            );

            expect(await readDevelopmentMigrationIdentity(repositoryRoot)).toBe(initial);
        });
    });

    test("reports a change that lands between state preparation and observation", async () => {
        await withMigrationFixture(async (repositoryRoot) => {
            const initial = await readDevelopmentMigrationIdentity(repositoryRoot);
            await writeMigrationFixture(
                repositoryRoot,
                "CREATE TABLE identity_changed_before_observation (id INTEGER PRIMARY KEY);\n",
                '{"version":1}\n'
            );
            const expected = await readDevelopmentMigrationIdentity(repositoryRoot);

            const observation = observeDevelopmentMigrationIdentity(
                repositoryRoot,
                initial
            );
            try {
                expect(await observation.ready).toBe(expected);
                expect(await observation.changed).toBe(expected);
            } finally {
                observation.close();
            }
        });
    });

    test("ignores ordinary source edits so normal HMR remains child-owned", async () => {
        await withMigrationFixture(async (repositoryRoot) => {
            const initial = await readDevelopmentMigrationIdentity(repositoryRoot);
            const observation = observeDevelopmentMigrationIdentity(
                repositoryRoot,
                initial
            );
            try {
                expect(await observation.ready).toBeUndefined();
                await writeFile(
                    path.join(repositoryRoot, "src", "unrelated.ts"),
                    "export const unrelated = true;\n",
                    "utf8"
                );
                const changed = await Promise.race([
                    observation.changed.then(() => true),
                    Bun.sleep(500).then(() => false),
                ]);
                expect(changed).toBeFalse();
            } finally {
                observation.close();
            }
        });
    });

    test("rejects hash drift, extra artifacts, and symlinked artifacts", async () => {
        await withMigrationFixture(async (repositoryRoot) => {
            const migrationRoot = path.join(repositoryRoot, "migrations", migrationId);
            const migrationPath = path.join(migrationRoot, "migration.sql");
            await writeFile(migrationPath, "unreviewed migration\n", "utf8");
            expect(readDevelopmentMigrationIdentity(repositoryRoot)).rejects.toThrow(
                "Development migration identity is invalid"
            );

            await writeMigrationFixture(
                repositoryRoot,
                "CREATE TABLE identity_one (id INTEGER PRIMARY KEY);\n",
                '{"version":1}\n'
            );
            await writeFile(
                path.join(migrationRoot, "unexpected.txt"),
                "extra\n",
                "utf8"
            );
            expect(readDevelopmentMigrationIdentity(repositoryRoot)).rejects.toThrow(
                "Development migration identity is invalid"
            );
            await rm(path.join(migrationRoot, "unexpected.txt"));

            const outside = path.join(repositoryRoot, "outside.sql");
            await writeFile(outside, "outside\n", "utf8");
            await rm(migrationPath);
            await symlink(outside, migrationPath);
            expect(readDevelopmentMigrationIdentity(repositoryRoot)).rejects.toThrow(
                "Development migration identity is invalid"
            );
        });
    });
});
