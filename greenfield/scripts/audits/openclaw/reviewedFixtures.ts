import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readBoundedUtf8RegularFile } from "../../files/boundedFile.ts";
import {
    agentsFixtureSchema,
    chatFixtureSchema,
    cronFixtureSchema,
    gatewayFixtureSchema,
    operationsFixtureSchema,
    parseFixtureDocument,
    parseFixtureManifest,
    parseSourceAuditResult,
    sessionsFixtureSchema,
    settingsFixtureSchema,
    tasksFixtureSchema,
    type FixtureManifest,
    type SourceAuditResult,
} from "./sourceAuditSchemas.ts";

const maximumFixtureBytes = 256 * 1024;
const reviewedFixtureFileNames = [
    "agents.json",
    "chat.json",
    "cron.json",
    "gateway.json",
    "manifest.json",
    "operations.json",
    "sessions.json",
    "settings.json",
    "tasks.json",
] as const;

export const defaultReviewedOpenClawFixtureRoot = new URL(
    "fixtures/2026.7.2-beta.7/",
    import.meta.url
);

export interface ReviewedOpenClawFixtures {
    audit: SourceAuditResult;
    manifest: FixtureManifest;
}

function compareStrings(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function canonicalJson(value: unknown): string {
    return `${JSON.stringify(value, null, 4)}\n`;
}

function sha256(contents: Uint8Array): string {
    return createHash("sha256").update(contents).digest("hex");
}

async function readBoundedFixture(
    fixtureRoot: string,
    fileName: string
): Promise<{ bytes: Buffer; serialized: string }> {
    const target = path.resolve(fixtureRoot, fileName);
    if (!target.startsWith(`${fixtureRoot}${path.sep}`)) {
        throw new Error("Reviewed OpenClaw fixture escaped its version directory");
    }
    const fixture = await readBoundedUtf8RegularFile(
        target,
        fixtureRoot,
        maximumFixtureBytes,
        `Reviewed OpenClaw fixture ${fileName} has invalid file state`,
        `Reviewed OpenClaw fixture ${fileName} is not valid UTF-8`
    );
    return { bytes: fixture.bytes, serialized: fixture.text };
}

/**
 * Loads only committed, synthetic fixtures and verifies their byte hashes.
 * @param selectedFixtureRoot Reviewed version directory or its file URL.
 * @returns Strictly parsed manifest and component facts.
 */
export async function loadReviewedOpenClawFixtures(
    selectedFixtureRoot: string | URL = defaultReviewedOpenClawFixtureRoot
): Promise<ReviewedOpenClawFixtures> {
    let selectedPath: string;
    if (selectedFixtureRoot instanceof URL) {
        const manifestUrl = new URL("manifest.json", selectedFixtureRoot);
        selectedPath = path.dirname(fileURLToPath(manifestUrl));
    } else {
        selectedPath = selectedFixtureRoot;
    }
    const fixtureRoot = path.resolve(selectedPath);
    const fixtureEntries = await readdir(fixtureRoot, { withFileTypes: true });
    const fileNames = fixtureEntries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .toSorted(compareStrings);
    if (JSON.stringify(fileNames) !== JSON.stringify(reviewedFixtureFileNames)) {
        throw new Error("Reviewed OpenClaw fixture directory has an unexpected file set");
    }

    const manifestFile = await readBoundedFixture(fixtureRoot, "manifest.json");
    const manifest = parseFixtureManifest(manifestFile.serialized);
    if (path.basename(fixtureRoot) !== manifest.source.version) {
        throw new Error(
            "Reviewed OpenClaw fixture directory does not match its source version"
        );
    }

    const componentFiles = new Map(
        await Promise.all(
            manifest.components.map(async (component) => {
                const fixture = await readBoundedFixture(fixtureRoot, component.file);
                if (sha256(fixture.bytes) !== component.sha256) {
                    throw new Error(
                        `Reviewed OpenClaw fixture hash mismatch for ${component.file}`
                    );
                }
                return [component.file, fixture.serialized] as const;
            })
        )
    );
    const required = (
        fileName: Exclude<(typeof reviewedFixtureFileNames)[number], "manifest.json">
    ) => {
        const serialized = componentFiles.get(fileName);
        if (!serialized)
            throw new Error(`Reviewed OpenClaw fixture is missing ${fileName}`);
        return serialized;
    };
    const audit = parseSourceAuditResult({
        agents: parseFixtureDocument(agentsFixtureSchema, required("agents.json")),
        chat: parseFixtureDocument(chatFixtureSchema, required("chat.json")),
        cron: parseFixtureDocument(cronFixtureSchema, required("cron.json")),
        gateway: parseFixtureDocument(gatewayFixtureSchema, required("gateway.json")),
        operations: parseFixtureDocument(
            operationsFixtureSchema,
            required("operations.json")
        ),
        sessions: parseFixtureDocument(sessionsFixtureSchema, required("sessions.json")),
        settings: parseFixtureDocument(settingsFixtureSchema, required("settings.json")),
        tasks: parseFixtureDocument(tasksFixtureSchema, required("tasks.json")),
        source: manifest.source,
        sourceArtifacts: manifest.sourceArtifacts,
    });
    if (audit.gateway.protocolVersion !== audit.source.protocolVersion) {
        throw new Error("Reviewed OpenClaw fixture protocol versions differ");
    }
    return { audit, manifest };
}

/**
 * Fails when an explicit host audit differs from the reviewed fixture set.
 * @param observed Source-derived audit candidate.
 * @param reviewed Hash-verified committed fixture set.
 * @returns Nothing when both canonical audit values match.
 */
export function assertOpenClawAuditMatchesReviewed(
    observed: SourceAuditResult,
    reviewed: SourceAuditResult
): void {
    const parsedObserved = parseSourceAuditResult(observed);
    const parsedReviewed = parseSourceAuditResult(reviewed);
    if (canonicalJson(parsedObserved) !== canonicalJson(parsedReviewed)) {
        throw new Error(
            "Installed OpenClaw source differs from the reviewed protocol fixtures"
        );
    }
}

function fixtureComponents(audit: SourceAuditResult): readonly [string, unknown][] {
    return [
        ["agents.json", audit.agents],
        ["chat.json", audit.chat],
        ["cron.json", audit.cron],
        ["gateway.json", audit.gateway],
        ["operations.json", audit.operations],
        ["sessions.json", audit.sessions],
        ["settings.json", audit.settings],
        ["tasks.json", audit.tasks],
    ];
}

/**
 * Emits a candidate fixture directory for review without touching committed evidence.
 * @param audit Strict source-derived audit candidate.
 * @param selectedOutputDirectory New absolute candidate version directory.
 * @returns Completion after an atomic directory rename.
 */
export async function writeOpenClawAuditCandidate(
    audit: SourceAuditResult,
    selectedOutputDirectory: string
): Promise<void> {
    const parsedAudit = parseSourceAuditResult(audit);
    if (
        !path.isAbsolute(selectedOutputDirectory) ||
        selectedOutputDirectory.includes("\0")
    ) {
        throw new TypeError("OpenClaw audit output directory must be an absolute path");
    }
    const outputDirectory = path.resolve(selectedOutputDirectory);
    if (path.basename(outputDirectory) !== parsedAudit.source.version) {
        throw new Error(
            "OpenClaw audit output directory must be named after the source version"
        );
    }
    let outputDirectoryExists = true;
    try {
        await stat(outputDirectory);
    } catch (error) {
        if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
        ) {
            outputDirectoryExists = false;
        } else {
            throw error;
        }
    }
    if (outputDirectoryExists) {
        throw new Error("OpenClaw audit output directory already exists");
    }

    const parentDirectory = path.dirname(outputDirectory);
    await mkdir(parentDirectory, { recursive: true });
    const temporaryDirectory = await mkdtemp(
        path.join(parentDirectory, `.${parsedAudit.source.version}.candidate-`)
    );
    try {
        const components = fixtureComponents(parsedAudit);
        const manifestComponents: FixtureManifest["components"] = [];
        for (const [fileName, value] of components) {
            const serialized = canonicalJson(value);
            await writeFile(path.join(temporaryDirectory, fileName), serialized, {
                encoding: "utf8",
                flag: "wx",
            });
            manifestComponents.push({
                file: fileName as FixtureManifest["components"][number]["file"],
                sha256: sha256(Buffer.from(serialized, "utf8")),
            });
        }
        const manifest: FixtureManifest = {
            components: manifestComponents,
            contentPolicy: {
                containsHostConfiguration: false,
                containsRuntimeState: false,
                containsSecrets: false,
                sourceArtifacts: "hashes-only",
                syntheticPayloadsOnly: true,
            },
            schemaVersion: 1,
            source: parsedAudit.source,
            sourceArtifacts: parsedAudit.sourceArtifacts,
        };
        await writeFile(
            path.join(temporaryDirectory, "manifest.json"),
            canonicalJson(manifest),
            { encoding: "utf8", flag: "wx" }
        );
        await rename(temporaryDirectory, outputDirectory);
    } catch (error) {
        await rm(temporaryDirectory, { force: true, recursive: true });
        throw error;
    }
}
