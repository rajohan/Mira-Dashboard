import fs from "node:fs";
import path from "node:path";

import { YAML } from "bun";

import {
    type ComposeEnvironment,
    loadComposeEnvironmentFiles,
    loadComposeProjectEnvironment,
    resolveComposeRelativePath,
} from "./composeEnvironment.ts";
import { asRecord } from "./support.ts";
import type { JsonRecord } from "./types.ts";

const COMPOSE_FILENAMES = [
    "compose.yaml",
    "compose.yml",
    "docker-compose.yaml",
    "docker-compose.yml",
];

function isIncludePathMatchCompose(
    baseDirectory: string,
    includePath: string,
    composePath: string,
    composeEnvironment: ComposeEnvironment
): boolean {
    const resolvedIncludePath = resolveComposeRelativePath(
        baseDirectory,
        includePath,
        composeEnvironment
    );
    const resolvedComposePath = path.resolve(composePath);
    if (resolvedIncludePath === resolvedComposePath) {
        return true;
    }
    try {
        return fs.realpathSync(resolvedIncludePath) === fs.realpathSync(composePath);
    } catch {
        return false;
    }
}

function isProjectComposeIncludeCompose(
    projectComposePath: string,
    composePath: string,
    seen = new Set<string>(),
    projectDirectory = path.dirname(projectComposePath),
    composeEnvironment = loadComposeProjectEnvironment(projectDirectory)
): boolean {
    try {
        const realProjectComposePath = fs.realpathSync(projectComposePath);
        const contextKey = JSON.stringify({
            env: Object.entries(composeEnvironment).toSorted(([left], [right]) =>
                left.localeCompare(right)
            ),
            path: realProjectComposePath,
            projectDirectory: path.resolve(projectDirectory),
        });
        if (seen.has(contextKey)) {
            return false;
        }
        const branchSeen = new Set([...seen, contextKey]);
        const document = YAML.parse(
            fs.readFileSync(projectComposePath, "utf8")
        ) as JsonRecord;
        const includes = Array.isArray(document.include) ? document.include : [];
        return includes.some((entry) => {
            const entryRecord = asRecord(entry);
            const includeValue = typeof entry === "string" ? entry : entryRecord.path;
            const includePaths = (
                Array.isArray(includeValue) ? includeValue : [includeValue]
            ).filter((item): item is string => typeof item === "string");
            const entryComposeEnvironment = {
                ...loadComposeEnvironmentFiles(
                    projectDirectory,
                    entryRecord.env_file,
                    composeEnvironment
                ),
                ...composeEnvironment,
            };
            const hasExplicitEnvironmentFile = entryRecord.env_file !== undefined;
            const rawProjectDirectory = entryRecord.project_directory;
            const nestedProjectDirectory =
                typeof rawProjectDirectory === "string"
                    ? resolveComposeRelativePath(
                          projectDirectory,
                          rawProjectDirectory,
                          entryComposeEnvironment
                      )
                    : undefined;
            for (const includePath of includePaths) {
                if (
                    isIncludePathMatchCompose(
                        projectDirectory,
                        includePath,
                        composePath,
                        entryComposeEnvironment
                    )
                ) {
                    return true;
                }
                const resolvedIncludePath = resolveComposeRelativePath(
                    projectDirectory,
                    includePath,
                    entryComposeEnvironment
                );
                const resolvedProjectDirectory =
                    nestedProjectDirectory ?? path.dirname(resolvedIncludePath);
                const nestedComposeEnvironment = {
                    ...(!hasExplicitEnvironmentFile &&
                        loadComposeProjectEnvironment(resolvedProjectDirectory)),
                    ...entryComposeEnvironment,
                };
                if (
                    fs.existsSync(resolvedIncludePath) &&
                    isProjectComposeIncludeCompose(
                        resolvedIncludePath,
                        composePath,
                        new Set(branchSeen),
                        resolvedProjectDirectory,
                        nestedComposeEnvironment
                    )
                ) {
                    return true;
                }
            }
            return false;
        });
    } catch {
        return false;
    }
}

function defaultComposeOverridePaths(composePath: string): string[] {
    const composeDirectory = path.dirname(composePath);
    const composeName = path.basename(composePath);
    const overrideNames =
        composeName === "docker-compose.yaml" || composeName === "docker-compose.yml"
            ? ["docker-compose.override.yaml", "docker-compose.override.yml"]
            : ["compose.override.yaml", "compose.override.yml"];
    const overridePath = overrideNames
        .map((overrideName) => path.join(composeDirectory, overrideName))
        .find((candidate) => fs.existsSync(candidate));
    return overridePath ? [fs.realpathSync(overridePath)] : [];
}

function isComposeFileDefineServiceImage(
    composePath: string,
    serviceName: string
): boolean {
    try {
        const document = YAML.parse(fs.readFileSync(composePath, "utf8")) as JsonRecord;
        const services = asRecord(document.services);
        const service = asRecord(services[serviceName]);
        return typeof service.image === "string";
    } catch {
        return false;
    }
}

export function composeFileServiceImageField(
    composePath: string,
    serviceName: string
): string | undefined {
    return isComposeFileDefineServiceImage(composePath, serviceName)
        ? `services.${serviceName}.image`
        : undefined;
}

function isProjectComposeOrOverrideIncludeCompose(
    projectComposePath: string,
    configuredComposePath: string
): boolean {
    return [projectComposePath, ...defaultComposeOverridePaths(projectComposePath)].some(
        (composePath) =>
            isProjectComposeIncludeCompose(composePath, configuredComposePath)
    );
}

function findIncludedComposeInDirectory(
    currentDirectory: string,
    configuredComposePath: string
): string | undefined {
    for (const filename of COMPOSE_FILENAMES) {
        const candidate = path.join(currentDirectory, filename);
        if (
            candidate !== configuredComposePath &&
            fs.existsSync(candidate) &&
            isProjectComposeOrOverrideIncludeCompose(candidate, configuredComposePath)
        ) {
            return candidate;
        }
    }
    return undefined;
}

function findProjectComposePath(configuredComposePath: string): string {
    let currentDirectory = path.dirname(configuredComposePath);
    let projectComposePath = configuredComposePath;
    while (true) {
        const candidate = findIncludedComposeInDirectory(
            currentDirectory,
            configuredComposePath
        );
        if (candidate) {
            projectComposePath = candidate;
        }
        const parent = path.dirname(currentDirectory);
        if (parent === currentDirectory) break;
        currentDirectory = parent;
    }
    return projectComposePath;
}

export function composeCommandPath(configuredComposePath: string): string {
    const projectComposePath = findProjectComposePath(configuredComposePath);
    if (projectComposePath !== configuredComposePath) {
        return projectComposePath;
    }
    try {
        return fs.realpathSync(configuredComposePath);
    } catch {
        return configuredComposePath;
    }
}

export function isParentComposePath(
    projectComposePath: string,
    configuredComposePath: string
): boolean {
    try {
        return (
            fs.realpathSync(projectComposePath) !== fs.realpathSync(configuredComposePath)
        );
    } catch {
        return path.resolve(projectComposePath) !== path.resolve(configuredComposePath);
    }
}

export function composeFilesForCommand(
    composePath: string,
    shouldIncludeDefaultOverrides: boolean
): string[] {
    const files = [composePath];
    if (shouldIncludeDefaultOverrides) {
        files.push(...defaultComposeOverridePaths(composePath));
    }
    return files;
}
