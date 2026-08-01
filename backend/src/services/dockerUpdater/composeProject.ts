import fs from "node:fs";
import path from "node:path";

import { YAML } from "bun";

import { nonEmptyEnvironmentFallback } from "../../lib/values.ts";
import { asRecord, getDockerBin } from "./support.ts";
import type { JsonRecord } from "./types.ts";
const COMPOSE_FILENAMES = [
    "compose.yaml",
    "compose.yml",
    "docker-compose.yaml",
    "docker-compose.yml",
];

function getDockerComposeWrapper(): string {
    const dockerRoot = getDockerRoot();
    return nonEmptyEnvironmentFallback(
        "MIRA_DOCKER_COMPOSE_WRAPPER",
        `${dockerRoot}/bin/docker-compose-doppler`
    );
}

function getDockerRoot(): string {
    return nonEmptyEnvironmentFallback("MIRA_DOCKER_ROOT", "/opt/docker");
}

export function getDockerAppsRoot(): string {
    return nonEmptyEnvironmentFallback("MIRA_DOCKER_APPS_ROOT", "/opt/docker/apps");
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
    const relative = path.relative(rootPath, candidatePath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalDockerRoots(): string[] {
    return [...new Set([getDockerAppsRoot(), getDockerRoot()])]
        .map((root) => {
            try {
                const canonicalRoot = fs.realpathSync(root);
                return fs.statSync(canonicalRoot).isDirectory()
                    ? canonicalRoot
                    : undefined;
            } catch {
                return;
            }
        })
        .filter((root): root is string => root !== undefined);
}

export function managedComposePath(composePath: string): string {
    const absolutePath = path.resolve(composePath);
    const stat = fs.lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new TypeError("Managed compose paths must be single-link regular files");
    }
    const canonicalPath = fs.realpathSync(absolutePath);
    if (!canonicalDockerRoots().some((root) => isPathWithinRoot(canonicalPath, root))) {
        throw new TypeError(
            "Managed compose path must stay within a configured Docker root"
        );
    }
    return canonicalPath;
}

type ComposeEnvironment = Record<string, string>;

function stripEnvironmentComment(line: string): string {
    let quote: string | undefined;
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (character === '"' || character === "'") {
            let backslashCount = 0;
            for (
                let slashIndex = index - 1;
                slashIndex >= 0 && line[slashIndex] === "\\";
                slashIndex -= 1
            ) {
                backslashCount += 1;
            }
            if (backslashCount % 2 === 1) continue;
            quote = quote === character ? undefined : (quote ?? character);
            continue;
        }
        // Compose treats inline comments as comments only when the # follows whitespace.
        if (
            character === "#" &&
            quote === undefined &&
            (index === 0 || /\s/u.test(line[index - 1] ?? ""))
        ) {
            return line.slice(0, index).trimEnd();
        }
    }
    return line;
}

function unescapeDoubleQuotedEnvironmentValue(value: string): string {
    return value.replaceAll(/\\([\\"nrt])/gu, (_match, escaped: string) => {
        if (escaped === "n") return "\n";
        if (escaped === "r") return "\r";
        if (escaped === "t") return "\t";
        return escaped;
    });
}

function parseComposeEnvironmentFile(content: string): ComposeEnvironment {
    const environment: ComposeEnvironment = {};
    for (const rawLine of content.split(/\r?\n/u)) {
        const line = stripEnvironmentComment(rawLine.trim());
        if (!line || line.startsWith("#")) continue;
        const withoutExport = line.startsWith("export ")
            ? line.slice(7).trimStart()
            : line;
        const separatorIndex = withoutExport.indexOf("=");
        if (separatorIndex <= 0) continue;
        const key = withoutExport.slice(0, separatorIndex).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) continue;
        let value = withoutExport.slice(separatorIndex + 1).trim();
        const isDoubleQuoted =
            value.length >= 2 && value.startsWith('"') && value.endsWith('"');
        const isSingleQuoted =
            value.length >= 2 && value.startsWith("'") && value.endsWith("'");
        if (isDoubleQuoted || isSingleQuoted) {
            value = value.slice(1, -1);
            if (isDoubleQuoted) {
                value = unescapeDoubleQuotedEnvironmentValue(value);
            }
        }
        environment[key] = value;
    }
    return environment;
}

function readComposeEnvironmentFile(environmentPath: string): ComposeEnvironment {
    try {
        if (!fs.existsSync(environmentPath)) return {};
        return parseComposeEnvironmentFile(fs.readFileSync(environmentPath, "utf8"));
    } catch {
        return {};
    }
}

function composeEnvironmentFilePaths(
    projectDirectory: string,
    environmentFileValue: unknown,
    composeEnvironment: ComposeEnvironment = {}
): string[] {
    return (
        Array.isArray(environmentFileValue)
            ? environmentFileValue
            : [environmentFileValue]
    )
        .filter((item): item is string => typeof item === "string")
        .map((rawEnvironmentFilePath) => {
            const environmentFilePath = interpolateComposePath(
                rawEnvironmentFilePath,
                composeEnvironment
            );
            return path.isAbsolute(environmentFilePath)
                ? environmentFilePath
                : path.resolve(projectDirectory, environmentFilePath);
        });
}

function loadComposeEnvironmentFiles(
    projectDirectory: string,
    environmentFileValue: unknown,
    composeEnvironment: ComposeEnvironment = {}
): ComposeEnvironment {
    return Object.assign(
        {},
        ...composeEnvironmentFilePaths(
            projectDirectory,
            environmentFileValue,
            composeEnvironment
        ).map((environmentPath) => readComposeEnvironmentFile(environmentPath))
    ) as ComposeEnvironment;
}

function loadComposeProjectEnvironment(
    projectDirectory: string,
    environmentFileValue?: unknown
): ComposeEnvironment {
    const defaultEnvironment = readComposeEnvironmentFile(
        path.join(projectDirectory, ".env")
    );
    return {
        ...defaultEnvironment,
        ...loadComposeEnvironmentFiles(
            projectDirectory,
            environmentFileValue,
            defaultEnvironment
        ),
    };
}

function resolveComposeEnvironmentValue(
    name: string,
    composeEnvironment: ComposeEnvironment
): string | undefined {
    return process.env[name] ?? composeEnvironment[name];
}

function interpolateComposePath(
    value: string,
    composeEnvironment: ComposeEnvironment = {}
): string {
    let interpolated = value;
    for (let index = 0; index < 8; index += 1) {
        const next = interpolateComposePathOnce(interpolated, composeEnvironment);
        if (next === interpolated) return next;
        interpolated = next;
    }
    return interpolated;
}

function interpolateComposePathOnce(
    value: string,
    composeEnvironment: ComposeEnvironment = {}
): string {
    const braced = value.replaceAll(
        /\$\{([^}:?+-]+)(?:(:?[-?+])([^}]*))?\}/gu,
        (match, rawName, op, fallback) => {
            const environmentName = String(rawName);
            const environmentValue = resolveComposeEnvironmentValue(
                environmentName,
                composeEnvironment
            );
            if (!op) return environmentValue ?? match;
            const hasValue = environmentValue !== undefined && environmentValue !== "";
            if (op === ":-" || op === "-") {
                return hasValue || (op === "-" && environmentValue !== undefined)
                    ? environmentValue
                    : String(fallback);
            }
            if (op === ":+" || op === "+") {
                return hasValue || (op === "+" && environmentValue !== undefined)
                    ? String(fallback)
                    : "";
            }
            return hasValue ? environmentValue : match;
        }
    );
    return braced.replaceAll(/\$([_a-z]\w*)/giu, (match, rawName) => {
        const environmentValue = resolveComposeEnvironmentValue(
            String(rawName),
            composeEnvironment
        );
        return environmentValue ?? match;
    });
}

function resolveComposeRelativePath(
    baseDirectory: string,
    includePath: string,
    composeEnvironment: ComposeEnvironment = {}
): string {
    const interpolatedPath = interpolateComposePath(includePath, composeEnvironment);
    return path.isAbsolute(interpolatedPath)
        ? interpolatedPath
        : path.resolve(baseDirectory, interpolatedPath);
}

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

function isParentComposePath(
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

function composeFileArguments(composePaths: string[]): string[] {
    return composePaths.flatMap((composePath) => ["-f", composePath]);
}

export function getComposeCommand(
    configuredComposePath: string,
    serviceName: string,
    verifiedComposePaths?: string[]
) {
    const dockerRoot = getDockerRoot();
    const wrapper = getDockerComposeWrapper();
    const projectComposePath =
        verifiedComposePaths?.[0] ?? composeCommandPath(configuredComposePath);
    const composePaths =
        verifiedComposePaths ??
        composeFilesForCommand(
            projectComposePath,
            isParentComposePath(projectComposePath, configuredComposePath)
        );
    const isManagedDockerPath = path
        .resolve(projectComposePath)
        .startsWith(`${path.resolve(dockerRoot)}${path.sep}`);
    const composeArgs = [
        ...composeFileArguments(composePaths),
        "up",
        "-d",
        "--pull",
        "always",
        serviceName,
    ];
    const cwd = path.dirname(projectComposePath);
    if (
        process.env.MIRA_DOCKER_COMPOSE_WRAPPER ||
        (isManagedDockerPath && fs.existsSync(wrapper))
    ) {
        return {
            file: wrapper,
            args: composeArgs,
            cwd,
        };
    }
    return {
        file: getDockerBin(),
        args: ["compose", ...composeArgs],
        cwd,
    };
}

export function getComposeCommandPaths(configuredComposePath: string): string[] {
    const projectComposePath = composeCommandPath(configuredComposePath);
    return composeFilesForCommand(
        projectComposePath,
        isParentComposePath(projectComposePath, configuredComposePath)
    );
}
