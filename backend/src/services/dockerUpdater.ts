import fs from "node:fs";
import path from "node:path";

import { YAML } from "bun";

import { database, sqlNullable } from "../database.ts";
import { runProcess } from "../lib/processes.ts";
import { nonEmptyEnvironmentFallback } from "../lib/values.ts";
import { dirtyDockerUpdaterPaths, syncDockerUpdaterChanges } from "./gitHygiene.ts";
import type { ScheduledJob } from "./scheduledJobs.ts";
import {
    getScheduledJob,
    registerScheduledJobAction,
    removeScheduledJobsNotInAction,
    ScheduledJobActionError,
    upsertScheduledJob,
} from "./scheduledJobs.ts";

const COMPOSE_FILENAMES = [
    "compose.yaml",
    "compose.yml",
    "docker-compose.yaml",
    "docker-compose.yml",
];
const SUPPORTED_REGISTRIES = new Set(["docker.io", "ghcr.io", "lscr.io"]);
const REGISTRY_TAG_PAGE_SIZE = 1000;
const MAX_REGISTRY_TAG_PAGES = 100;
const composeUpdateLocks = new Map<string, { promise: Promise<void> }>();
const drainedRegistryResponses = new WeakSet<Response>();

function getDockerBin(): string {
    return nonEmptyEnvironmentFallback("MIRA_DOCKER_BIN", "docker");
}

function failedDiscoveryAppSlugs(register: DockerUpdaterStepResult): Set<string> {
    if (!register.stderr) {
        return new Set();
    }
    try {
        const parsed = JSON.parse(register.stderr) as {
            failed?: Array<{ appSlug?: unknown; blocking?: unknown }>;
        };
        return new Set(
            (parsed.failed ?? [])
                .filter(
                    (failure) =>
                        typeof failure.appSlug === "string" && failure.blocking !== false
                )
                .map((failure) => failure.appSlug as string)
        );
    } catch {
        return new Set(["*"]);
    }
}

function shouldBlockManualUpdateForDiscoveryFailure(
    register: DockerUpdaterStepResult,
    appSlug: string
): boolean {
    if (register.isOk) {
        return false;
    }
    const failedAppSlugs = failedDiscoveryAppSlugs(register);
    return failedAppSlugs.has("*") || failedAppSlugs.has(appSlug);
}

function shouldBlockGlobalUpdateForDiscoveryFailure(
    register: DockerUpdaterStepResult
): boolean {
    return !register.isOk && failedDiscoveryAppSlugs(register).has("*");
}

export function isNonblockingRegistrationFailure(step: DockerUpdaterStepResult): boolean {
    return (
        step.step === "register-services" &&
        !step.isOk &&
        failedDiscoveryAppSlugs(step).size === 0
    );
}

function getDockerComposeWrapper(): string {
    const dockerRoot = nonEmptyEnvironmentFallback("MIRA_DOCKER_ROOT", "/opt/docker");
    return nonEmptyEnvironmentFallback(
        "MIRA_DOCKER_COMPOSE_WRAPPER",
        `${dockerRoot}/bin/docker-compose-doppler`
    );
}

function getDockerAppsRoot(): string {
    return nonEmptyEnvironmentFallback("MIRA_DOCKER_APPS_ROOT", "/opt/docker/apps");
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
    const branchSeen = new Set(seen);
    branchSeen.add(contextKey);
    try {
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

function composeFileServiceImageField(
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

function composeCommandPath(configuredComposePath: string): string {
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

function composeFilesForCommand(
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

function getComposeCommand(configuredComposePath: string, serviceName: string) {
    const dockerRoot = nonEmptyEnvironmentFallback("MIRA_DOCKER_ROOT", "/opt/docker");
    const wrapper = getDockerComposeWrapper();
    const projectComposePath = composeCommandPath(configuredComposePath);
    const isIncludeDefaultOverrides = isParentComposePath(
        projectComposePath,
        configuredComposePath
    );
    const composePaths = composeFilesForCommand(
        projectComposePath,
        isIncludeDefaultOverrides
    );
    const isManagedDockerPath = path
        .resolve(projectComposePath)
        .startsWith(`${path.resolve(dockerRoot)}${path.sep}`);
    if (
        process.env.MIRA_DOCKER_COMPOSE_WRAPPER ||
        (isManagedDockerPath && fs.existsSync(wrapper))
    ) {
        return {
            file: wrapper,
            args: [
                ...composeFileArguments(composePaths),
                "up",
                "-d",
                "--pull",
                "always",
                serviceName,
            ],
            cwd: path.dirname(projectComposePath),
        };
    }
    return {
        file: getDockerBin(),
        args: [
            "compose",
            ...composeFileArguments(composePaths),
            "up",
            "-d",
            "--pull",
            "always",
            serviceName,
        ],
        cwd: path.dirname(projectComposePath),
    };
}

function getComposeCommandPaths(configuredComposePath: string): string[] {
    const projectComposePath = composeCommandPath(configuredComposePath);
    return composeFilesForCommand(
        projectComposePath,
        isParentComposePath(projectComposePath, configuredComposePath)
    );
}

export interface DockerUpdaterStepResult {
    step: string;
    isOk: boolean;
    stdout: string;
    stderr: string;
    changedPaths?: string[];
    code?: "NOT_FOUND" | "DISABLED" | "CONFLICT" | "UNSUPPORTED_REGISTRY";
}

interface ManagedServiceRow {
    id: number;
    app_slug: string;
    service_name: string;
    compose_path: string;
    image_repo: string;
    compose_image_ref: string | undefined;
    compose_image_field: string | undefined;
    current_tag: string | undefined;
    current_digest: string | undefined;
    latest_tag: string | undefined;
    latest_digest: string | undefined;
    policy: string;
    pin_mode: string;
    tag_match_type: string;
    tag_match_pattern: string | undefined;
    enabled: number;
    metadata_json: string | undefined;
    last_status: string | undefined;
}

function normalizeManagedServiceRow(
    row: ManagedServiceRow | undefined
): ManagedServiceRow | undefined {
    if (!row) return undefined;
    return {
        ...row,
        compose_image_field: row.compose_image_field ?? undefined,
        compose_image_ref: row.compose_image_ref ?? undefined,
        current_digest: row.current_digest ?? undefined,
        current_tag: row.current_tag ?? undefined,
        last_status: row.last_status ?? undefined,
        latest_digest: row.latest_digest ?? undefined,
        latest_tag: row.latest_tag ?? undefined,
        metadata_json: row.metadata_json ?? undefined,
        tag_match_pattern: row.tag_match_pattern ?? undefined,
    };
}

function normalizeManagedServiceRows(rows: ManagedServiceRow[]): ManagedServiceRow[] {
    return rows.map((row) => normalizeManagedServiceRow(row)!);
}

type JsonRecord = Record<string, unknown>;

interface DiscoveredComposeService {
    appSlug: string;
    serviceName: string;
    composePath: string;
    imageRepo: string;
    composeImageRef: string;
    composeImageField: string;
    currentTag: string | undefined;
    currentDigest: string | undefined;
    policy: "auto" | "notify";
    pinMode: "tag" | "digest";
    tagMatchType: "exact" | "regex";
    tagMatchPattern: string | undefined;
    enabled: boolean;
    metadata: Record<string, unknown>;
}

interface RegistryFetchOptions {
    accept?: string;
    authorization?: string;
    signal?: AbortSignal;
}

interface RegistryCredentials {
    password: string;
    username: string;
}

function nowIso(): string {
    const now = new Date();
    return now.toISOString();
}

function normalizeComposeLabelValue(value: unknown): string {
    return String(value ?? "").replaceAll("$$", "$");
}

function normalizeLabels(rawLabels: unknown): Map<string, string> {
    if (Array.isArray(rawLabels)) {
        return new Map(
            rawLabels.map((label) => {
                const text = String(label);
                const index = text.indexOf("=");
                return index === -1
                    ? [text, ""]
                    : [
                          text.slice(0, index),
                          normalizeComposeLabelValue(text.slice(index + 1)),
                      ];
            })
        );
    }
    if (rawLabels && typeof rawLabels === "object") {
        return new Map(
            Object.entries(rawLabels).map(([key, value]) => [
                String(key),
                normalizeComposeLabelValue(value),
            ])
        );
    }
    return new Map();
}

function parseImageReference(imageReference: string) {
    const digestIndex = imageReference.indexOf("@");
    const beforeDigest =
        digestIndex === -1 ? imageReference : imageReference.slice(0, digestIndex);
    const digest = digestIndex === -1 ? undefined : imageReference.slice(digestIndex + 1);
    const slashIndex = beforeDigest.lastIndexOf("/");
    const colonIndex = beforeDigest.lastIndexOf(":");
    const hasTag = colonIndex > slashIndex;
    return {
        repo: hasTag ? beforeDigest.slice(0, colonIndex) : beforeDigest,
        tag: hasTag ? beforeDigest.slice(colonIndex + 1) : undefined,
        digest,
        pinMode: digest ? "digest" : "tag",
    };
}

function serviceLabel(service: Pick<ManagedServiceRow, "app_slug" | "service_name">) {
    return `${service.app_slug}/${service.service_name}`;
}

function normalizeDockerHubRepo(repo: string): string {
    if (repo.includes("/")) {
        return repo;
    }
    return `library/${repo}`;
}

function caughtMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): JsonRecord {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as JsonRecord)
        : {};
}

function trimEnvironment(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value || undefined;
}

function registryCredentials(registry: string): RegistryCredentials | undefined {
    if (["docker.io", "registry.docker.io", "registry-1.docker.io"].includes(registry)) {
        const username = trimEnvironment("DOCKER_LOGIN");
        const password = trimEnvironment("DOCKER_TOKEN");
        return username && password ? { username, password } : undefined;
    }
    if (registry === "ghcr.io" || registry === "lscr.io") {
        const username = trimEnvironment("MIRA_GITHUB_USERNAME");
        const password = trimEnvironment("MIRA_GITHUB_TOKEN");
        return username && password ? { username, password } : undefined;
    }
    return undefined;
}

function registryHostFromUrl(url: string): string {
    try {
        const parsedUrl = new URL(url);
        return parsedUrl.hostname;
    } catch {
        return imageRegistry(url);
    }
}

function isTrustedTokenRealm(registry: string, tokenUrl: URL): boolean {
    const hostname = tokenUrl.hostname.toLowerCase();
    if (["docker.io", "registry.docker.io", "registry-1.docker.io"].includes(registry)) {
        return ["auth.docker.io", "registry.docker.io", "registry-1.docker.io"].includes(
            hostname
        );
    }
    if (registry === "lscr.io") {
        return hostname === "lscr.io" || hostname === "ghcr.io";
    }
    return hostname === registry;
}

function basicAuthorization(credentials: RegistryCredentials): string {
    return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toBase64()}`;
}

function parseBearerChallenge(
    header: string | undefined
): Record<string, string> | undefined {
    if (!header?.toLowerCase().startsWith("bearer ")) return undefined;
    const parameters = new Map<string, string>();
    for (const match of header
        .slice("bearer ".length)
        .matchAll(/([a-z_]+)="([^"]*)"/giu)) {
        const [, key, value] = match;
        if (key !== undefined && value !== undefined) {
            parameters.set(key.toLowerCase(), value);
        }
    }
    const realm = parameters.get("realm");
    if (!realm) return undefined;
    return Object.fromEntries(parameters);
}

async function drainResponseBody(response: Response): Promise<void> {
    if (drainedRegistryResponses.has(response)) return;
    drainedRegistryResponses.add(response);
    if (typeof response.arrayBuffer !== "function") return;
    try {
        await response.arrayBuffer();
    } catch {
        // Draining is best-effort before retrying authenticated registry requests.
    }
}

async function fetchRegistryResponse(
    url: string,
    options: RegistryFetchOptions = {}
): Promise<{ authorization?: string; response: Response; clearTimer: () => void }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const abortFromSignal = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abortFromSignal, { once: true });
    if (options.signal?.aborted) abortFromSignal();
    const clearTimer = () => {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abortFromSignal);
    };
    const headers = {
        Accept: options.accept || "application/json",
        ...(options.authorization && { Authorization: options.authorization }),
        "User-Agent": "mira-dashboard-docker-updater/1.0",
    };
    try {
        const response = await fetch(url, { headers, signal: controller.signal });
        if (response.status !== 401) {
            return { authorization: options.authorization, response, clearTimer };
        }
        const challenge = parseBearerChallenge(
            response.headers.get("www-authenticate") ?? undefined
        );
        if (!challenge?.realm) {
            return { authorization: options.authorization, response, clearTimer };
        }
        await drainResponseBody(response);
        const tokenUrl = new URL(challenge.realm);
        if (challenge.service) tokenUrl.searchParams.set("service", challenge.service);
        if (challenge.scope) tokenUrl.searchParams.set("scope", challenge.scope);
        const registry = registryHostFromUrl(url);
        const credentials = isTrustedTokenRealm(registry, tokenUrl)
            ? registryCredentials(registry)
            : undefined;
        const tokenResponse = await fetch(tokenUrl, {
            headers: {
                Accept: "application/json",
                ...(credentials && { Authorization: basicAuthorization(credentials) }),
                "User-Agent": "mira-dashboard-docker-updater/1.0",
            },
            signal: controller.signal,
        });
        if (!tokenResponse.ok) {
            await drainResponseBody(tokenResponse);
            return { authorization: options.authorization, response, clearTimer };
        }
        const tokenBody = asRecord(await tokenResponse.json());
        const token =
            typeof tokenBody.token === "string"
                ? tokenBody.token
                : typeof tokenBody.access_token === "string"
                  ? tokenBody.access_token
                  : undefined;
        if (!token) {
            return { response, clearTimer };
        }
        const authenticated = await fetch(url, {
            headers: {
                ...headers,
                Authorization: `Bearer ${token}`,
            },
            signal: controller.signal,
        });
        return {
            authorization: `Bearer ${token}`,
            response: authenticated,
            clearTimer,
        };
    } catch (error) {
        clearTimer();
        throw error;
    }
}

function parseNextLink(header: string | undefined, baseUrl?: string): string | undefined {
    if (!header) return undefined;
    for (const part of header.split(",")) {
        const [rawUrl, ...parameters] = part.trim().split(";");
        if (
            parameters.some((parameter) => parameter.trim() === 'rel="next"') &&
            rawUrl?.startsWith("<") &&
            rawUrl.endsWith(">")
        ) {
            const link = rawUrl.slice(1, -1);
            if (!baseUrl) {
                return link;
            }
            const nextUrl = new URL(link, baseUrl);
            return nextUrl.href;
        }
    }
    return undefined;
}

function isTrustedRegistryPaginationUrl(
    url: string,
    registryHost: string,
    repo: string
): boolean {
    const parsed = new URL(url);
    const expected = new URL(`https://${registryHost}/v2/${repo}/tags/list`);
    return (
        parsed.protocol === "https:" &&
        parsed.origin === expected.origin &&
        parsed.pathname === expected.pathname
    );
}

async function fetchRegistryJsonWithHeaders(
    url: string,
    options: RegistryFetchOptions = {}
): Promise<{ authorization?: string; body: JsonRecord; headers: Headers }> {
    try {
        const { authorization, response, clearTimer } = await fetchRegistryResponse(
            url,
            options
        );
        if (!response.ok) {
            try {
                await drainResponseBody(response);
            } finally {
                clearTimer();
            }
            throw new Error(`HTTP ${response.status} for ${url}`);
        }
        try {
            const body = asRecord(await response.json());
            return { authorization, body, headers: response.headers };
        } finally {
            clearTimer();
        }
    } catch (error) {
        options.signal?.throwIfAborted();
        if (error instanceof Error && error.name === "AbortError") {
            throw new Error(`Request timeout for ${url}`, { cause: error });
        }
        throw error;
    }
}

function isGhcrRepo(repo: string): boolean {
    return repo.startsWith("ghcr.io/");
}

function imageRegistry(repo: string): string {
    const first = repo.split("/", 1)[0] || "";
    const registry =
        first === "localhost" || first.includes(".") || first.includes(":")
            ? first
            : "docker.io";
    return registry === "index.docker.io" ? "docker.io" : registry;
}

function stripRegistry(repo: string) {
    if (isGhcrRepo(repo)) {
        return repo.replace(/^ghcr\.io\//u, "");
    }
    if (repo.startsWith("lscr.io/")) {
        return repo.replace(/^lscr\.io\//u, "");
    }
    if (repo.startsWith("docker.io/") || repo.startsWith("index.docker.io/")) {
        return repo.replace(/^(?:index\.)?docker\.io\//u, "");
    }
    return repo;
}

function isTagMatch(service: ManagedServiceRow, tag: string): boolean {
    if (!service.tag_match_pattern) {
        return tag === service.current_tag;
    }
    if (service.tag_match_type === "regex") {
        return isSafeTagPatternMatch(service.tag_match_pattern, tag);
    }
    return tag === service.tag_match_pattern;
}

type SafeTagPatternPart = { kind: "digits" } | { kind: "literal"; value: string };

function parseSafeTagRegexPattern(pattern: string): SafeTagPatternPart[] | undefined {
    if (pattern.length === 0 || pattern.length > 128) {
        return undefined;
    }
    if (!pattern.startsWith("^") || !pattern.endsWith("$")) {
        return undefined;
    }

    let body = pattern.slice(1);
    while (body.endsWith("$")) {
        body = body.slice(0, -1);
    }
    if (!body) {
        return undefined;
    }

    const parts: SafeTagPatternPart[] = [];
    for (let index = 0; index < body.length; index += 1) {
        const character = body[index];
        if (character === undefined) {
            return undefined;
        }
        if (character === "\\") {
            const escaped = body[index + 1];
            if (!escaped) {
                return undefined;
            }
            if (escaped === "d" && body[index + 2] === "+") {
                if (parts.at(-1)?.kind === "digits") {
                    return undefined;
                }
                parts.push({ kind: "digits" });
                index += 2;
                if (/^\d$/u.test(body[index + 1] ?? "")) {
                    return undefined;
                }
                continue;
            }
            if (/^[-.+_]$/u.test(escaped)) {
                parts.push({ kind: "literal", value: escaped });
                index += 1;
                continue;
            }
            return undefined;
        }
        if (character === "[") {
            const closeIndex = body.indexOf("]", index + 1);
            if (closeIndex === -1 || body[closeIndex + 1] !== "+") {
                return undefined;
            }
            const characterClass = body.slice(index + 1, closeIndex);
            if (characterClass !== "0-9" && characterClass !== String.raw`\d`) {
                return undefined;
            }
            if (parts.at(-1)?.kind === "digits") {
                return undefined;
            }
            parts.push({ kind: "digits" });
            index = closeIndex + 1;
            if (/^\d$/u.test(body[index + 1] ?? "")) {
                return undefined;
            }
            continue;
        }
        if (/^[A-Za-z0-9_-]$/u.test(character)) {
            if (/^\d$/u.test(character) && parts.at(-1)?.kind === "digits") {
                return undefined;
            }
            parts.push({ kind: "literal", value: character });
            continue;
        }
        return undefined;
    }
    return parts;
}

export function isSafeTagRegexPattern(pattern: string): boolean {
    return parseSafeTagRegexPattern(pattern) !== undefined;
}

export function isSafeTagPatternMatch(pattern: string, tag: string): boolean {
    const parts = parseSafeTagRegexPattern(pattern);
    if (!parts) {
        return false;
    }

    let offset = 0;
    for (const part of parts) {
        if (part.kind === "literal") {
            if (tag[offset] !== part.value) {
                return false;
            }
            offset += 1;
            continue;
        }

        const digitStart = offset;
        while (offset < tag.length && /\d/u.test(tag[offset] ?? "")) {
            offset += 1;
        }
        if (offset === digitStart) {
            return false;
        }
    }
    return offset === tag.length;
}

function shouldNeedFullTagScan(service: ManagedServiceRow): boolean {
    if (service.tag_match_type !== "regex" || !service.tag_match_pattern) {
        return false;
    }
    return isSafeTagRegexPattern(service.tag_match_pattern);
}

function compareTags(a: string, b: string): number {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function hostDockerPlatform(): string {
    const arch = process.arch === "x64" ? "amd64" : process.arch;
    return `linux/${arch}`;
}

function servicePlatform(service: ManagedServiceRow): string {
    let metadata: JsonRecord;
    try {
        metadata = asRecord(
            service.metadata_json ? JSON.parse(service.metadata_json) : {}
        );
    } catch {
        metadata = {};
    }
    return typeof metadata.platform === "string" && metadata.platform
        ? metadata.platform
        : process.env.MIRA_DOCKER_UPDATER_PLATFORM || hostDockerPlatform();
}

function isImageMatchPlatform(image: JsonRecord, platform: string): boolean {
    const [os = "linux", architecture = "", variant] = platform.split("/", 3);
    const imageOs = typeof image.os === "string" ? image.os : "linux";
    if (imageOs !== os || image.architecture !== architecture) return false;
    if (!variant) {
        return (
            image.variant === undefined ||
            image.variant === null ||
            (architecture === "arm64" && image.variant === "v8")
        );
    }
    return image.variant === variant;
}

function manifestDigestForPlatform(
    body: JsonRecord,
    platform: string
): string | undefined {
    const manifest = (Array.isArray(body.manifests) ? body.manifests : []).find(
        (candidate) =>
            isImageMatchPlatform(asRecord(asRecord(candidate).platform), platform)
    );
    const digest = asRecord(manifest).digest;
    return typeof digest === "string" ? digest : undefined;
}

async function lookupRegistryV2(service: ManagedServiceRow, signal?: AbortSignal) {
    const registry = imageRegistry(service.image_repo);
    const registryHost = registry === "docker.io" ? "registry-1.docker.io" : registry;
    const repo =
        registry === "docker.io"
            ? normalizeDockerHubRepo(stripRegistry(service.image_repo))
            : stripRegistry(service.image_repo);
    let tag =
        service.tag_match_type === "exact"
            ? (service.tag_match_pattern ?? service.current_tag)
            : service.current_tag;
    if (shouldNeedFullTagScan(service)) {
        const tags: string[] = [];
        let tagsUrl: string | undefined =
            `https://${registryHost}/v2/${repo}/tags/list?n=${REGISTRY_TAG_PAGE_SIZE}`;
        let tagListAuthorization: string | undefined;
        let tagPageCount = 0;
        while (tagsUrl) {
            tagPageCount += 1;
            if (tagPageCount > MAX_REGISTRY_TAG_PAGES) {
                throw new Error(
                    `${registry} tag pagination exceeded ${MAX_REGISTRY_TAG_PAGES} pages for ${repo}`
                );
            }
            const { authorization, body, headers } = await fetchRegistryJsonWithHeaders(
                tagsUrl,
                { authorization: tagListAuthorization, signal }
            );
            tagListAuthorization = authorization;
            tags.push(
                ...(Array.isArray(body.tags)
                    ? body.tags.filter((item): item is string => typeof item === "string")
                    : [])
            );
            const nextTagsUrl = parseNextLink(headers.get("link") ?? undefined, tagsUrl);
            if (
                nextTagsUrl &&
                !isTrustedRegistryPaginationUrl(nextTagsUrl, registryHost, repo)
            ) {
                throw new Error(
                    `${registry} tag pagination redirected to untrusted registry URL for ${repo}`
                );
            }
            tagsUrl = nextTagsUrl;
        }
        const candidates = tags
            .filter((candidate) => candidate && isTagMatch(service, candidate))
            .toSorted(compareTags);
        tag = candidates.at(-1) ?? tag;
    }
    if (!tag) {
        return { latestTag: undefined, latestDigest: undefined };
    }
    const { body, headers } = await fetchRegistryJsonWithHeaders(
        `https://${registryHost}/v2/${repo}/manifests/${tag}`,
        {
            accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json",
            signal,
        }
    );
    const manifestDigest = manifestDigestForPlatform(body, servicePlatform(service));
    return {
        latestTag: tag,
        latestDigest:
            manifestDigest ||
            headers.get("docker-content-digest") ||
            (typeof body.digest === "string" ? body.digest : undefined),
    };
}

async function lookupLatest(service: ManagedServiceRow, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (process.env.MIRA_DOCKER_UPDATER_SKIP_REGISTRY === "1") {
        return {
            latestTag: service.current_tag,
            latestDigest: service.current_digest,
        };
    }
    const registry = imageRegistry(service.image_repo);
    if (!SUPPORTED_REGISTRIES.has(registry)) {
        return {
            latestTag: undefined,
            latestDigest: undefined,
            unsupported: true,
        };
    }
    return lookupRegistryV2(service, signal);
}

function hasUpdate(service: ManagedServiceRow): boolean {
    if (service.pin_mode === "digest") {
        return Boolean(
            service.latest_digest &&
            (!service.current_digest || service.latest_digest !== service.current_digest)
        );
    }
    return Boolean(
        (service.latest_tag &&
            (!service.current_tag || service.latest_tag !== service.current_tag)) ||
        (service.latest_digest &&
            (!service.current_digest || service.latest_digest !== service.current_digest))
    );
}

function buildTargetImageReference(service: ManagedServiceRow): string {
    const parsed = parseImageReference(service.compose_image_ref || service.image_repo);
    if (service.pin_mode === "digest" && service.latest_digest) {
        const tag = service.latest_tag || parsed.tag;
        return tag
            ? `${parsed.repo}:${tag}@${service.latest_digest}`
            : `${parsed.repo}@${service.latest_digest}`;
    }
    return `${parsed.repo}:${service.latest_tag || service.current_tag || "latest"}`;
}

function setNestedValue(target: JsonRecord, dottedPath: string, value: string) {
    const rawParts = dottedPath.split(".");
    const parts =
        rawParts[0] === "services" && rawParts.at(-1) === "image" && rawParts.length > 3
            ? ["services", rawParts.slice(1, -1).join("."), "image"]
            : rawParts;
    const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);
    for (const part of parts) {
        if (unsafeKeys.has(part)) {
            throw new Error(`Unsafe compose image field segment: ${part}`);
        }
    }
    let current = target;
    const parentParts = parts.slice(0, -1);
    for (const part of parentParts) {
        if (!Object.hasOwn(current, part)) {
            throw new Error(`Compose image field path does not exist: ${dottedPath}`);
        }
        const next = current[part];
        if (
            !next ||
            typeof next !== "object" ||
            Object.getPrototypeOf(next) !== Object.prototype
        ) {
            throw new Error(`Compose image field path is not an object: ${dottedPath}`);
        }
        current = next as JsonRecord;
    }
    const lastPart = parts.at(-1) as string;
    if (!Object.hasOwn(current, lastPart)) {
        throw new Error(`Compose image field path does not exist: ${dottedPath}`);
    }
    current[lastPart] = value;
}

function composeImageFieldServiceName(dottedPath: string): string | undefined {
    const rawParts = dottedPath.split(".");
    if (rawParts[0] !== "services" || rawParts.at(-1) !== "image") {
        return undefined;
    }
    if (rawParts.length < 3) {
        return undefined;
    }
    return rawParts.slice(1, -1).join(".");
}

function escapeRegExp(value: string): string {
    return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function leadingWhitespaceLength(value: string): number {
    return value.match(/^\s*/)?.[0].length ?? 0;
}

function isBlankOrCommentLine(value: string): boolean {
    const trimmed = value.trim();
    return trimmed === "" || trimmed.startsWith("#");
}

function firstChildIndent(lines: string[], startIndex: number, parentIndent: number) {
    let childIndent: number | undefined;
    for (let index = startIndex; index < lines.length; index += 1) {
        const line = lines[index];
        if (line === undefined || isBlankOrCommentLine(line)) continue;
        const indent = leadingWhitespaceLength(line);
        if (indent <= parentIndent) break;
        childIndent = indent;
        break;
    }
    return childIndent;
}

function isComplexYamlScalar(value: string): boolean {
    const trimmed = value.trimStart();
    return (
        trimmed.startsWith(">") ||
        trimmed.startsWith("|") ||
        trimmed.startsWith("&") ||
        trimmed.startsWith("!")
    );
}

function updateComposeImageLine(
    raw: string,
    composeImageField: string,
    targetImageReference: string
): string | undefined {
    const serviceName = composeImageFieldServiceName(composeImageField);
    if (!serviceName) return undefined;

    const lineEnding = raw.includes("\r\n") ? "\r\n" : "\n";
    const hasTrailingLineEnding = raw.endsWith("\n");
    const lines = raw.split(/\r?\n/);
    if (hasTrailingLineEnding) lines.pop();

    const servicesLineIndex = lines.findIndex((line) =>
        /^services\s*:\s*(?:#.*)?$/.test(line)
    );
    if (servicesLineIndex === -1) return undefined;

    const servicesLine = lines[servicesLineIndex];
    if (servicesLine === undefined) return undefined;
    const servicesIndent = leadingWhitespaceLength(servicesLine);
    const serviceChildIndent = firstChildIndent(
        lines,
        servicesLineIndex + 1,
        servicesIndent
    );
    if (serviceChildIndent === undefined) return undefined;
    const escapedServiceName = escapeRegExp(serviceName);
    const serviceLinePattern = new RegExp(
        String.raw`^(\s*)(?:"${escapedServiceName}"|'${escapedServiceName}'|${escapedServiceName})\s*:\s*(?:#.*)?$`
    );
    let serviceLineIndex = -1;
    let serviceIndent = -1;
    for (let index = servicesLineIndex + 1; index < lines.length; index += 1) {
        const line = lines[index];
        if (line === undefined) continue;
        if (isBlankOrCommentLine(line)) continue;
        const indent = leadingWhitespaceLength(line);
        if (indent <= servicesIndent) break;
        if (indent !== serviceChildIndent) continue;
        const match = line.match(serviceLinePattern);
        if (!match) continue;
        serviceLineIndex = index;
        serviceIndent = match[1]?.length ?? 0;
        break;
    }
    if (serviceLineIndex === -1) return undefined;
    const servicePropertyIndent = firstChildIndent(
        lines,
        serviceLineIndex + 1,
        serviceIndent
    );
    if (servicePropertyIndent === undefined) return undefined;

    for (let index = serviceLineIndex + 1; index < lines.length; index += 1) {
        const line = lines[index];
        if (line === undefined) continue;
        if (isBlankOrCommentLine(line)) continue;
        const indent = leadingWhitespaceLength(line);
        if (indent <= serviceIndent) break;
        if (indent !== servicePropertyIndent) continue;
        const match = line.match(
            /^(\s*image\s*:\s*)(?:(['"])(.*?)\2|([^#]*?))(\s*(?:#.*)?)$/
        );
        if (!match) continue;
        const prefix = match[1];
        const quote = match[2] ?? "";
        const unquotedValue = match[4] ?? "";
        if (!quote && isComplexYamlScalar(unquotedValue)) {
            return undefined;
        }
        const suffix = match[5] ?? "";
        const nextValue = quote
            ? `${quote}${targetImageReference}${quote}`
            : targetImageReference;
        lines[index] = `${prefix}${nextValue}${suffix}`;
        return `${lines.join(lineEnding)}${hasTrailingLineEnding ? lineEnding : ""}`;
    }

    return undefined;
}

function serializeComposeUpdate(
    raw: string,
    document: JsonRecord,
    composeImageField: string,
    targetImageReference: string
): string {
    return (
        updateComposeImageLine(raw, composeImageField, targetImageReference) ??
        YAML.stringify(document)
    );
}

function writeFileWithMetadata(
    targetPath: string,
    content: string,
    stats: Pick<fs.Stats, "mode" | "uid" | "gid">
) {
    const mode = stats.mode & 0o7777;
    const fd = fs.openSync(
        targetPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        mode
    );
    let isCommitted = false;
    try {
        fs.writeFileSync(fd, content, "utf8");
        fs.fchmodSync(fd, mode);
        const currentStats = fs.fstatSync(fd);
        if (currentStats.uid !== stats.uid || currentStats.gid !== stats.gid) {
            try {
                fs.fchownSync(fd, stats.uid, stats.gid);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EPERM") {
                    throw error;
                }
            }
        }
        isCommitted = true;
    } finally {
        fs.closeSync(fd);
        if (!isCommitted) {
            try {
                fs.unlinkSync(targetPath);
            } catch {
                // Preserve the original write failure.
            }
        }
    }
}

function insertEvent(
    service: ManagedServiceRow,
    eventType: string,
    message: string,
    details: Record<string, unknown> = {}
) {
    database
        .prepare(
            `INSERT INTO docker_update_events (
            managed_service_id, app_slug, service_name, event_type, from_tag, to_tag,
            from_digest, to_digest, message, details_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
            service.id,
            service.app_slug,
            service.service_name,
            eventType,
            sqlNullable(service.current_tag),
            sqlNullable(service.latest_tag),
            sqlNullable(service.current_digest),
            sqlNullable(service.latest_digest),
            message,
            JSON.stringify(details),
            nowIso()
        );
}

function insertEventBestEffort(
    service: ManagedServiceRow,
    eventType: string,
    message: string,
    details: Record<string, unknown> = {}
) {
    try {
        insertEvent(service, eventType, message, details);
    } catch (error) {
        console.error("[DockerUpdater] Failed to persist update event", {
            error: caughtMessage(error),
            eventType,
            service: serviceLabel(service),
        });
    }
}

function createNotification(
    title: string,
    description: string,
    dedupeKey: string,
    type: "info" | "error" = "info",
    metadata: JsonRecord = {}
) {
    const timestamp = nowIso();
    database
        .prepare(
            `INSERT INTO notifications (
            title, description, type, source, dedupe_key, metadata_json,
            is_read, created_at, updated_at, occurred_at
         ) VALUES (?, ?, ?, 'docker-updater', ?, ?, 0, ?, ?, ?)
         ON CONFLICT(dedupe_key) DO UPDATE SET
            title = excluded.title,
            description = excluded.description,
            type = excluded.type,
            metadata_json = excluded.metadata_json,
            is_read = 0,
            updated_at = excluded.updated_at,
            occurred_at = excluded.occurred_at`
        )
        .run(
            title,
            description,
            type,
            dedupeKey,
            JSON.stringify(metadata),
            timestamp,
            timestamp,
            timestamp
        );
}

function createNotificationBestEffort(
    title: string,
    description: string,
    dedupeKey: string,
    type: "info" | "error" = "info",
    metadata: JsonRecord = {}
) {
    try {
        createNotification(title, description, dedupeKey, type, metadata);
    } catch (error) {
        console.error("[DockerUpdater] Failed to persist notification", {
            dedupeKey,
            error: caughtMessage(error),
            title,
        });
    }
}

function composeUpdateLockKey(service: ManagedServiceRow): string {
    return composeCommandPath(service.compose_path);
}

async function withComposeUpdateLock<T>(
    service: ManagedServiceRow,
    action: () => Promise<T>,
    signal?: AbortSignal
): Promise<T> {
    const key = composeUpdateLockKey(service);
    const wasPrevious = composeUpdateLocks.get(key)?.promise ?? Promise.resolve();
    const current = Promise.withResolvers<void>();
    const release = current.resolve;
    async function waitForCurrent(): Promise<void> {
        await wasPrevious;
        await current.promise;
    }
    const next = { promise: waitForCurrent() };
    composeUpdateLocks.set(key, next);
    try {
        if (signal) {
            signal.throwIfAborted();
            const aborted = Promise.withResolvers<never>();
            const abort = () => aborted.reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            try {
                await Promise.race([wasPrevious, aborted.promise]);
            } finally {
                signal.removeEventListener("abort", abort);
            }
            signal.throwIfAborted();
        } else {
            await wasPrevious;
        }
        return await action();
    } finally {
        release();
        if (composeUpdateLocks.get(key) === next) {
            composeUpdateLocks.delete(key);
        }
    }
}

async function applyComposeUpdateUnlocked(
    service: ManagedServiceRow,
    targetImageReference: string,
    signal?: AbortSignal
) {
    signal?.throwIfAborted();
    if (!service.compose_image_field) {
        throw new Error(
            `Service ${serviceLabel(service)} is missing compose image field`
        );
    }
    const composeImageField = service.compose_image_field;
    const configuredComposePath = service.compose_path;
    const composePath = fs.realpathSync(configuredComposePath);
    const commandComposePaths = getComposeCommandPaths(configuredComposePath);
    const dirtyBefore = await dirtyDockerUpdaterPaths(
        [
            composePath,
            ...commandComposePaths.map((commandComposePath) =>
                fs.realpathSync(commandComposePath)
            ),
        ],
        signal
    );
    signal?.throwIfAborted();
    const raw = fs.readFileSync(composePath, "utf8");
    const originalStats = fs.statSync(composePath);
    const document = YAML.parse(raw) as JsonRecord;
    setNestedValue(document, composeImageField, targetImageReference);
    let isComposeStarted = false;
    const commandRollbacks: Array<{
        composePath: string;
        rollbackTempPath: string;
        tempPath: string;
    }> = [];
    const temporaryPath = path.join(
        path.dirname(composePath),
        `${path.basename(composePath)}.tmp-${Bun.randomUUIDv7()}`
    );
    const rollbackTemporaryPath = path.join(
        path.dirname(composePath),
        `${path.basename(composePath)}.rollback-${Bun.randomUUIDv7()}`
    );
    try {
        writeFileWithMetadata(rollbackTemporaryPath, raw, originalStats);
        writeFileWithMetadata(
            temporaryPath,
            serializeComposeUpdate(
                raw,
                document,
                composeImageField,
                targetImageReference
            ),
            originalStats
        );
        fs.renameSync(temporaryPath, composePath);
        for (const commandComposePath of commandComposePaths) {
            const realCommandComposePath = fs.realpathSync(commandComposePath);
            if (realCommandComposePath === composePath) continue;
            const commandImageField = composeFileServiceImageField(
                realCommandComposePath,
                service.service_name
            );
            if (!commandImageField) continue;
            const commandRaw = fs.readFileSync(realCommandComposePath, "utf8");
            const commandStats = fs.statSync(realCommandComposePath);
            const commandDocument = YAML.parse(commandRaw) as JsonRecord;
            setNestedValue(commandDocument, commandImageField, targetImageReference);
            const commandTemporaryPath = path.join(
                path.dirname(realCommandComposePath),
                `${path.basename(realCommandComposePath)}.tmp-${Bun.randomUUIDv7()}`
            );
            const commandRollbackTemporaryPath = path.join(
                path.dirname(realCommandComposePath),
                `${path.basename(realCommandComposePath)}.rollback-${Bun.randomUUIDv7()}`
            );
            writeFileWithMetadata(commandRollbackTemporaryPath, commandRaw, commandStats);
            commandRollbacks.push({
                composePath: realCommandComposePath,
                rollbackTempPath: commandRollbackTemporaryPath,
                tempPath: commandTemporaryPath,
            });
            writeFileWithMetadata(
                commandTemporaryPath,
                serializeComposeUpdate(
                    commandRaw,
                    commandDocument,
                    commandImageField,
                    targetImageReference
                ),
                commandStats
            );
            fs.renameSync(commandTemporaryPath, realCommandComposePath);
        }
        const command = getComposeCommand(configuredComposePath, service.service_name);
        isComposeStarted = true;
        const { code, stderr, stdout } = await runProcess(command.file, command.args, {
            cwd: command.cwd,
            env: process.env,
            maxBuffer: 10 * 1024 * 1024,
            signal,
            timeoutMs: 180_000,
        });
        if (code !== 0) {
            throw new Error(
                `${command.file} ${command.args.join(" ")} failed with exit code ${code}: ${
                    stderr.trim() || stdout.trim()
                }`
            );
        }
        try {
            fs.unlinkSync(rollbackTemporaryPath);
        } catch {
            // The rollback file is only a best-effort safety net after success.
        }
        for (const rollback of commandRollbacks) {
            try {
                fs.unlinkSync(rollback.rollbackTempPath);
            } catch {
                // Extra compose rollbacks are best-effort after success too.
            }
        }
        const changedPaths = [
            composePath,
            ...commandRollbacks.map((rollback) => rollback.composePath),
        ];
        return {
            changedPaths:
                dirtyBefore &&
                changedPaths.every(
                    (changedPath) => !dirtyBefore.has(path.resolve(changedPath))
                )
                    ? changedPaths
                    : [],
            stdout: String(stdout),
            stderr: String(stderr),
        };
    } catch (error) {
        try {
            fs.unlinkSync(temporaryPath);
        } catch {
            // The temp file may have already been atomically moved into place.
        }
        for (const rollback of [...commandRollbacks].toReversed()) {
            try {
                fs.unlinkSync(rollback.tempPath);
            } catch {
                // The temp file may have already been atomically moved into place.
            }
            try {
                if (fs.existsSync(rollback.rollbackTempPath)) {
                    fs.renameSync(rollback.rollbackTempPath, rollback.composePath);
                }
            } catch (rollbackError) {
                console.error("[DockerUpdater] Failed to restore compose file", {
                    composePath: rollback.composePath,
                    rollbackError,
                });
            }
        }
        let isRestored = false;
        try {
            if (fs.existsSync(rollbackTemporaryPath)) {
                fs.renameSync(rollbackTemporaryPath, composePath);
                isRestored = true;
            }
        } catch (rollbackError) {
            console.error("[DockerUpdater] Failed to restore compose file", {
                composePath,
                rollbackError,
            });
        }
        if (isRestored && isComposeStarted) {
            try {
                const command = getComposeCommand(
                    configuredComposePath,
                    service.service_name
                );
                const rollbackResult = await runProcess(command.file, command.args, {
                    cwd: command.cwd,
                    env: process.env,
                    maxBuffer: 10 * 1024 * 1024,
                    timeoutMs: 180_000,
                });
                if (rollbackResult.code !== 0) {
                    console.error(
                        "[DockerUpdater] Re-applying restored compose file failed",
                        {
                            code: rollbackResult.code,
                            output:
                                rollbackResult.stderr.trim() ||
                                rollbackResult.stdout.trim(),
                        }
                    );
                }
            } catch (rollbackError) {
                console.error(
                    "[DockerUpdater] Failed to re-apply restored compose file",
                    {
                        composePath,
                        rollbackError,
                    }
                );
            }
        }
        throw error;
    }
}

function isBooleanLabel(value: string | undefined, isFallback = false): boolean {
    if (value === undefined || value === "") return isFallback;
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function listComposeFiles(root = getDockerAppsRoot()): string[] {
    if (!fs.existsSync(root)) return [];
    return fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => {
            const appRoot = path.join(root, entry.name);
            const composePath = COMPOSE_FILENAMES.map((filename) =>
                path.join(appRoot, filename)
            ).find((file) => fs.existsSync(file));
            return composePath ? [composePath] : [];
        });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype
    );
}

function servicesFromCompose(composePath: string):
    | {
          appSlug: string;
          isOk: true;
          services: DiscoveredComposeService[];
      }
    | {
          appSlug: string;
          error: string;
          isOk: false;
          services: DiscoveredComposeService[];
      } {
    const appSlug = path.basename(path.dirname(composePath));
    try {
        const parsed = YAML.parse(fs.readFileSync(composePath, "utf8"));
        if (!isPlainObject(parsed) || !isPlainObject(parsed.services)) {
            return {
                appSlug,
                error: `Compose file ${composePath} must contain a services object`,
                isOk: false,
                services: [],
            };
        }

        const services: DiscoveredComposeService[] = [];
        const serviceErrors: string[] = [];
        for (const [serviceName, service] of Object.entries(parsed.services)) {
            if (!isPlainObject(service)) {
                serviceErrors.push(
                    `Compose service ${serviceName} in ${composePath} must be an object`
                );
                continue;
            }
            if (!("image" in service)) {
                continue;
            }
            if (typeof service.image !== "string") {
                serviceErrors.push(
                    `Compose service ${serviceName} in ${composePath} must define image as a string`
                );
                continue;
            }
            const imageReference = service.image;
            const labels = normalizeLabels(service.labels);
            const image = parseImageReference(imageReference);
            const configuredPinMode = labels
                .get("mira.updater.track")
                ?.trim()
                .toLowerCase();
            const tagPattern = labels.get("mira.updater.tagPattern") || undefined;
            const isTagPatternIsRegex = isBooleanLabel(
                labels.get("mira.updater.tagPatternIsRegex"),
                true
            );
            const currentTag = image.tag ?? (image.digest ? undefined : "latest");
            const pinMode: "digest" | "tag" =
                configuredPinMode === "digest" || configuredPinMode === "tag"
                    ? configuredPinMode
                    : image.pinMode === "digest"
                      ? "digest"
                      : "tag";
            let tagMatchType: "exact" | "regex" = "exact";
            const tagMatchPattern = tagPattern ?? currentTag;
            if (tagPattern && isTagPatternIsRegex) {
                if (!isSafeTagRegexPattern(tagPattern)) {
                    const message = `Unsafe tag pattern regex for ${appSlug}/${serviceName}: ${tagPattern} (pattern failed safety checks)`;
                    console.warn("[DockerUpdater] Ignoring unsafe tag pattern regex", {
                        appSlug,
                        serviceName,
                        tagPattern,
                        error: "pattern failed safety checks",
                    });
                    serviceErrors.push(message);
                    continue;
                }
                tagMatchType = "regex";
            }
            services.push({
                appSlug,
                serviceName,
                composePath,
                imageRepo: image.repo,
                composeImageRef: imageReference,
                composeImageField: `services.${serviceName}.image`,
                currentTag,
                currentDigest: image.digest,
                policy: isBooleanLabel(labels.get("mira.updater.autoUpdate"), false)
                    ? "auto"
                    : "notify",
                pinMode,
                tagMatchType,
                tagMatchPattern,
                enabled: labels.has("mira.updater.enabled")
                    ? isBooleanLabel(labels.get("mira.updater.enabled"), true)
                    : true,
                metadata: {
                    discoveredBy: "dashboard-docker-updater",
                    discoveredAt: nowIso(),
                    containerName:
                        typeof service.container_name === "string"
                            ? service.container_name
                            : undefined,
                    platform:
                        typeof service.platform === "string"
                            ? service.platform
                            : undefined,
                    labels: Object.fromEntries(labels),
                },
            });
        }
        if (serviceErrors.length > 0) {
            return {
                appSlug,
                error: serviceErrors.join("; "),
                isOk: false,
                services,
            };
        }
        return {
            appSlug,
            isOk: true,
            services,
        };
    } catch (error) {
        console.error("[DockerUpdater] Failed to discover compose services", {
            composePath,
            error,
        });
        return { appSlug, error: caughtMessage(error), isOk: false, services: [] };
    }
}

export async function registerDockerUpdaterServices(
    signal?: AbortSignal
): Promise<DockerUpdaterStepResult> {
    signal?.throwIfAborted();
    let composeFiles: string[];
    try {
        const appsRoot = getDockerAppsRoot();
        if (!fs.existsSync(appsRoot)) {
            return {
                isOk: false,
                step: "register-services",
                stdout: "",
                stderr: JSON.stringify({
                    registered: 0,
                    failed: [
                        {
                            appSlug: "*",
                            error: `Compose apps root not found: ${appsRoot}`,
                        },
                    ],
                }),
            };
        }
        composeFiles = listComposeFiles(appsRoot);
    } catch (error) {
        return {
            isOk: false,
            step: "register-services",
            stdout: "",
            stderr: JSON.stringify({
                registered: 0,
                failed: [{ appSlug: "*", error: caughtMessage(error) }],
            }),
        };
    }
    const discoveries = composeFiles.map((composeFile) =>
        servicesFromCompose(composeFile)
    );
    const failedDiscoveries = discoveries.filter((discovery) => !discovery.isOk);
    const successfulOrPartialDiscoveries = discoveries.filter(
        (discovery) => discovery.isOk || discovery.services.length > 0
    );
    const services = successfulOrPartialDiscoveries.flatMap(
        (discovery) => discovery.services
    );
    const timestamp = nowIso();
    const upsert = database.prepare(
        `INSERT INTO docker_managed_services (
            app_slug, service_name, compose_path, image_repo, compose_image_ref,
            compose_image_field, current_tag, current_digest, policy, pin_mode,
            tag_match_type, tag_match_pattern, enabled, metadata_json,
            last_checked_at, last_status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'registered')
         ON CONFLICT(app_slug, service_name) DO UPDATE SET
            compose_path = excluded.compose_path,
            image_repo = excluded.image_repo,
            compose_image_ref = excluded.compose_image_ref,
            compose_image_field = excluded.compose_image_field,
            current_tag = excluded.current_tag,
            current_digest = CASE
                WHEN excluded.current_digest IS NOT NULL THEN excluded.current_digest
                WHEN docker_managed_services.current_tag = excluded.current_tag
                    THEN docker_managed_services.current_digest
                ELSE NULL
            END,
            policy = excluded.policy,
            pin_mode = excluded.pin_mode,
            tag_match_type = excluded.tag_match_type,
            tag_match_pattern = excluded.tag_match_pattern,
            enabled = excluded.enabled,
            metadata_json = excluded.metadata_json,
            last_checked_at = docker_managed_services.last_checked_at,
            last_status = docker_managed_services.last_status`
    );
    let isTxnStarted = false;
    try {
        signal?.throwIfAborted();
        database.run("BEGIN");
        isTxnStarted = true;
        const discoveredAppSlugs = new Set(
            successfulOrPartialDiscoveries.map((item) => item.appSlug)
        );
        for (const appSlug of discoveredAppSlugs) {
            const serviceNames = new Set(
                services
                    .filter((service) => service.appSlug === appSlug)
                    .map((service) => service.serviceName)
            );
            for (const row of database
                .prepare(
                    "SELECT id, service_name FROM docker_managed_services WHERE app_slug = ?"
                )
                .all(appSlug) as Array<{ id: number; service_name: string }>) {
                if (!serviceNames.has(row.service_name)) {
                    database
                        .prepare("DELETE FROM docker_managed_services WHERE id = ?")
                        .run(row.id);
                }
            }
        }
        const failedAppSlugs = new Set(
            failedDiscoveries.map((discovery) => discovery.appSlug)
        );
        for (const row of database
            .prepare("SELECT DISTINCT app_slug FROM docker_managed_services")
            .all() as Array<{ app_slug: string }>) {
            if (
                !discoveredAppSlugs.has(row.app_slug) &&
                !failedAppSlugs.has(row.app_slug)
            ) {
                database
                    .prepare("DELETE FROM docker_managed_services WHERE app_slug = ?")
                    .run(row.app_slug);
            }
        }
        for (const service of services) {
            upsert.run(
                service.appSlug,
                service.serviceName,
                service.composePath,
                service.imageRepo,
                service.composeImageRef,
                service.composeImageField,
                sqlNullable(service.currentTag),
                sqlNullable(service.currentDigest),
                service.policy,
                service.pinMode,
                service.tagMatchType,
                sqlNullable(service.tagMatchPattern),
                service.enabled ? 1 : 0,
                JSON.stringify(service.metadata),
                timestamp
            );
        }
        database.run("COMMIT");
    } catch (error) {
        let failureMessage = caughtMessage(error);
        if (isTxnStarted) {
            try {
                database.run("ROLLBACK");
            } catch (rollbackError) {
                failureMessage += `; rollback failed: ${caughtMessage(rollbackError)}`;
            }
        }
        signal?.throwIfAborted();
        return {
            isOk: false,
            step: "register-services",
            stdout: "",
            stderr: JSON.stringify({
                registered: 0,
                failed: [{ appSlug: "*", error: failureMessage }],
            }),
        };
    }
    return {
        step: "register-services",
        isOk: failedDiscoveries.length === 0,
        stdout: JSON.stringify({
            isOk: failedDiscoveries.length === 0,
            summary: {
                composeFiles: composeFiles.length,
                failedComposeFiles: failedDiscoveries.length,
                registeredServices: services.length,
            },
        }),
        stderr:
            failedDiscoveries.length === 0
                ? ""
                : JSON.stringify({
                      failed: failedDiscoveries.map((discovery) => ({
                          appSlug: discovery.appSlug,
                          blocking: discovery.services.length === 0,
                          error: discovery.error,
                      })),
                  }),
    };
}

export async function pollDockerUpdaterRegistries(
    serviceId?: number,
    signal?: AbortSignal
): Promise<DockerUpdaterStepResult> {
    signal?.throwIfAborted();
    const timestamp = nowIso();
    const services = normalizeManagedServiceRows(
        serviceId === undefined
            ? (database
                  .prepare(
                      "SELECT * FROM docker_managed_services WHERE enabled = 1 ORDER BY app_slug, service_name"
                  )
                  .all() as unknown as ManagedServiceRow[])
            : (database
                  .prepare(
                      "SELECT * FROM docker_managed_services WHERE id = ? AND enabled = 1 ORDER BY app_slug, service_name"
                  )
                  .all(serviceId) as unknown as ManagedServiceRow[])
    );
    const checkedServices: string[] = [];
    const updates: string[] = [];
    const newUpdates: string[] = [];
    const skipped: Array<{ service: string; reason: string }> = [];
    const failures: Array<{ service: string; error: string }> = [];
    for (const service of services) {
        try {
            signal?.throwIfAborted();
            const latest = await lookupLatest(service, signal);
            if ("unsupported" in latest && latest.unsupported) {
                skipped.push({
                    service: serviceLabel(service),
                    reason: `Unsupported image registry: ${imageRegistry(service.image_repo)}`,
                });
                database
                    .prepare(
                        `UPDATE docker_managed_services
                     SET latest_tag = NULL, latest_digest = NULL,
                         last_checked_at = ?, last_status = 'unsupported_registry'
                     WHERE id = ?`
                    )
                    .run(timestamp, service.id);
                continue;
            }
            const updatedService = {
                ...service,
                latest_tag: latest.latestTag ?? undefined,
                latest_digest: latest.latestDigest ?? undefined,
            };
            const isUpdateAvailable = hasUpdate(updatedService);
            const isUpdateChanged =
                service.last_status !== "update_available" ||
                service.latest_tag !== updatedService.latest_tag ||
                service.latest_digest !== updatedService.latest_digest;
            database
                .prepare(
                    `UPDATE docker_managed_services
                 SET latest_tag = ?, latest_digest = ?, last_checked_at = ?, last_status = ?
                 WHERE id = ?`
                )
                .run(
                    sqlNullable(latest.latestTag ?? undefined),
                    sqlNullable(latest.latestDigest ?? undefined),
                    timestamp,
                    isUpdateAvailable ? "update_available" : "current",
                    service.id
                );
            checkedServices.push(serviceLabel(service));
            if (isUpdateAvailable) {
                updates.push(serviceLabel(service));
                if (isUpdateChanged) {
                    newUpdates.push(serviceLabel(service));
                    insertEventBestEffort(
                        updatedService,
                        "update_available",
                        "Docker update available"
                    );
                }
            }
        } catch (error) {
            signal?.throwIfAborted();
            failures.push({
                service: serviceLabel(service),
                error: caughtMessage(error),
            });
            database
                .prepare(
                    `UPDATE docker_managed_services
                 SET latest_tag = NULL, latest_digest = NULL,
                     last_checked_at = ?, last_status = 'registry_check_failed'
                 WHERE id = ?`
                )
                .run(timestamp, service.id);
        }
    }
    if (newUpdates.length > 0) {
        createNotificationBestEffort(
            "Docker updates available",
            newUpdates.join(", "),
            "docker:updater:updates-available"
        );
    }
    const isOk =
        failures.length === 0 || (serviceId === undefined && checkedServices.length > 0);
    return {
        step: "poll",
        isOk: isOk,
        stdout: JSON.stringify({
            isOk: isOk,
            checkedAt: timestamp,
            isChecked: checkedServices,
            skipped,
            updates,
        }),
        stderr: failures
            .map((failure) => `${failure.service}: ${failure.error}`)
            .join("\n"),
    };
}

async function applyServiceUpdate(
    service: ManagedServiceRow,
    eventPrefix: "auto" | "manual",
    signal?: AbortSignal
): Promise<DockerUpdaterStepResult> {
    return withComposeUpdateLock(
        service,
        async () => {
            signal?.throwIfAborted();
            const lockedService = normalizeManagedServiceRow(
                database
                    .prepare("SELECT * FROM docker_managed_services WHERE id = ? LIMIT 1")
                    .get(service.id) as ManagedServiceRow | undefined
            );
            if (!lockedService || lockedService.enabled !== 1) {
                const code = lockedService ? "DISABLED" : "NOT_FOUND";
                return {
                    step: `${eventPrefix}-update:${serviceLabel(service)}`,
                    isOk: false,
                    code,
                    stdout: "",
                    stderr: "Docker updater service not found or disabled",
                };
            }
            if (!hasUpdate(lockedService)) {
                return {
                    step: `${eventPrefix}-update:${serviceLabel(lockedService)}`,
                    isOk: false,
                    code: "CONFLICT",
                    stdout: "",
                    stderr: "No update available",
                };
            }
            const target = buildTargetImageReference(lockedService);
            let result: Awaited<ReturnType<typeof applyComposeUpdateUnlocked>>;
            try {
                // Compose writes tag-only refs for non-digest pins, then pulls so
                // digest drift still refreshes mutable tags without storing @digest.
                result = await applyComposeUpdateUnlocked(lockedService, target, signal);
            } catch (error) {
                signal?.throwIfAborted();
                const message = caughtMessage(error);
                database
                    .prepare(
                        `UPDATE docker_managed_services
                 SET last_checked_at = ?, last_status = ?
                 WHERE id = ?`
                    )
                    .run(nowIso(), `${eventPrefix}_update_failed`, lockedService.id);
                insertEventBestEffort(
                    lockedService,
                    `${eventPrefix}_update_failed`,
                    message,
                    {
                        targetComposeImageRef: target,
                    }
                );
                const [os = "linux", architecture] = servicePlatform(lockedService).split(
                    "/",
                    2
                );
                createNotificationBestEffort(
                    `Docker ${eventPrefix} update failed`,
                    `${serviceLabel(lockedService)}: ${message}`,
                    `docker:updater:${eventPrefix}-failed:${lockedService.id}:${nowIso().slice(0, 10)}`,
                    "error",
                    {
                        architecture,
                        digest: lockedService.latest_digest,
                        os,
                    }
                );
                return {
                    step: `${eventPrefix}-update:${serviceLabel(lockedService)}`,
                    isOk: false,
                    stdout: "",
                    stderr: message,
                };
            }

            try {
                database
                    .prepare(
                        `UPDATE docker_managed_services
                 SET compose_image_ref = ?, current_tag = ?, current_digest = ?,
                     tag_match_pattern = CASE
                         WHEN tag_match_type = 'exact' THEN ?
                         ELSE tag_match_pattern
                     END,
                     last_updated_at = ?, last_checked_at = ?, last_status = 'updated'
                 WHERE id = ?`
                    )
                    .run(
                        target,
                        sqlNullable(lockedService.latest_tag),
                        sqlNullable(lockedService.latest_digest),
                        sqlNullable(lockedService.latest_tag),
                        nowIso(),
                        nowIso(),
                        lockedService.id
                    );
                insertEventBestEffort(
                    lockedService,
                    `${eventPrefix}_update_succeeded`,
                    "Docker service updated",
                    { targetComposeImageRef: target }
                );
                createNotificationBestEffort(
                    "Docker service updated",
                    `${serviceLabel(lockedService)} updated to ${target}`,
                    `docker:updater:updated:${lockedService.id}:${target}`
                );
                return {
                    step: `${eventPrefix}-update:${serviceLabel(lockedService)}`,
                    changedPaths: result.changedPaths,
                    isOk: true,
                    stdout: result.stdout,
                    stderr: result.stderr,
                };
            } catch (error) {
                const message = caughtMessage(error);
                insertEventBestEffort(
                    lockedService,
                    `${eventPrefix}_update_reconcile_failed`,
                    `Docker service updated but failed to persist updater state: ${message}`,
                    {
                        targetComposeImageRef: target,
                    }
                );
                const [os = "linux", architecture] = servicePlatform(lockedService).split(
                    "/",
                    2
                );
                createNotificationBestEffort(
                    `Docker ${eventPrefix} update needs reconciliation`,
                    `${serviceLabel(lockedService)} updated to ${target}, but state persistence failed: ${message}`,
                    `docker:updater:${eventPrefix}-reconcile-failed:${lockedService.id}:${nowIso().slice(0, 10)}`,
                    "error",
                    {
                        architecture,
                        digest: lockedService.latest_digest,
                        os,
                    }
                );
                return {
                    step: `${eventPrefix}-update:${serviceLabel(lockedService)}`,
                    changedPaths: result.changedPaths,
                    isOk: false,
                    stdout: result.stdout,
                    stderr: `Docker service updated but failed to persist updater state: ${message}`,
                };
            }
        },
        signal
    );
}

async function pruneDanglingImagesBestEffort(signal?: AbortSignal): Promise<void> {
    try {
        const result = await runProcess(getDockerBin(), ["image", "prune", "-f"], {
            env: process.env,
            maxBuffer: 10 * 1024 * 1024,
            signal,
            timeoutMs: 120_000,
        });
        if (result.code !== 0) {
            throw new Error(
                result.stderr.trim() || `docker image prune exited ${result.code}`
            );
        }
    } catch (error) {
        signal?.throwIfAborted();
        console.error("[DockerUpdater] Failed to prune dangling images", {
            error: caughtMessage(error),
        });
    }
}

async function syncDockerUpdaterChangesBestEffort(
    steps: DockerUpdaterStepResult[],
    signal?: AbortSignal,
    protectFromCancellation?: () => void
): Promise<void> {
    const updateSteps = steps.filter((step) => step.step.includes("-update:"));
    if (updateSteps.length === 0) {
        try {
            const pendingResult = await syncDockerUpdaterChanges(
                [],
                signal,
                protectFromCancellation
            );
            if (pendingResult.pushed) {
                steps.push({
                    step: "git-sync:docker",
                    isOk: true,
                    stdout: JSON.stringify(pendingResult),
                    stderr: "",
                });
            }
        } catch (error) {
            signal?.throwIfAborted();
            steps.push({
                step: "git-sync:docker",
                isOk: false,
                stdout: "",
                stderr: caughtMessage(error),
            });
        }
        return;
    }
    const changedPaths = updateSteps.flatMap((step) => step.changedPaths ?? []);
    if (changedPaths.length === 0) {
        try {
            const pendingResult = await syncDockerUpdaterChanges(
                [],
                signal,
                protectFromCancellation
            );
            steps.push({
                step: "git-sync:docker",
                isOk: true,
                stdout: JSON.stringify(
                    pendingResult.pushed
                        ? pendingResult
                        : {
                              changedPaths: [],
                              pushed: false,
                              skippedReason: "no updated compose paths",
                          }
                ),
                stderr: "",
            });
        } catch (error) {
            signal?.throwIfAborted();
            steps.push({
                step: "git-sync:docker",
                isOk: false,
                stdout: "",
                stderr: caughtMessage(error),
            });
        }
        return;
    }
    try {
        const result = await syncDockerUpdaterChanges(
            changedPaths,
            signal,
            protectFromCancellation
        );
        steps.push({
            step: "git-sync:docker",
            isOk: true,
            stdout: JSON.stringify(result),
            stderr: "",
        });
    } catch (error) {
        signal?.throwIfAborted();
        steps.push({
            step: "git-sync:docker",
            isOk: false,
            stdout: "",
            stderr: caughtMessage(error),
        });
    }
}

export async function runDockerUpdaterService(
    serviceId?: number,
    signal?: AbortSignal,
    protectFromCancellation?: () => void
): Promise<DockerUpdaterStepResult[]> {
    signal?.throwIfAborted();
    let isMutationProtected = false;
    const protectMutation = () => {
        if (isMutationProtected) return;
        protectFromCancellation?.();
        isMutationProtected = true;
    };
    const requestedService =
        serviceId === undefined
            ? undefined
            : normalizeManagedServiceRow(
                  database
                      .prepare(
                          "SELECT * FROM docker_managed_services WHERE id = ? LIMIT 1"
                      )
                      .get(serviceId) as ManagedServiceRow | undefined
              );
    const register = await registerDockerUpdaterServices(signal);
    if (serviceId === undefined && shouldBlockGlobalUpdateForDiscoveryFailure(register)) {
        return [register];
    }
    if (serviceId !== undefined) {
        const service = normalizeManagedServiceRow(
            database
                .prepare("SELECT * FROM docker_managed_services WHERE id = ? LIMIT 1")
                .get(serviceId) as ManagedServiceRow | undefined
        );
        if (!service) {
            if (
                requestedService &&
                shouldBlockManualUpdateForDiscoveryFailure(
                    register,
                    requestedService.app_slug
                )
            ) {
                return [
                    register,
                    {
                        step: `manual-update:${serviceLabel(requestedService)}`,
                        isOk: false,
                        code: "CONFLICT",
                        stdout: "",
                        stderr: "Docker updater discovery failed for the selected service",
                    },
                ];
            }
            return [
                register,
                {
                    step: requestedService
                        ? `manual-update:${serviceLabel(requestedService)}`
                        : "manual-update",
                    isOk: false,
                    code: "NOT_FOUND",
                    stdout: "",
                    stderr: "Docker updater service not found",
                },
            ];
        }
        if (shouldBlockManualUpdateForDiscoveryFailure(register, service.app_slug)) {
            return [
                register,
                {
                    step: `manual-update:${serviceLabel(service)}`,
                    isOk: false,
                    code: "CONFLICT",
                    stdout: "",
                    stderr: "Docker updater discovery failed for the selected service",
                },
            ];
        }
        if (service.enabled !== 1) {
            return [
                register,
                {
                    step: `manual-update:${serviceLabel(service)}`,
                    isOk: false,
                    code: "DISABLED",
                    stdout: "",
                    stderr: "Docker updater service not found or disabled",
                },
            ];
        }
        const poll = await pollDockerUpdaterRegistries(service.id, signal);
        if (!poll?.isOk) {
            return [register, poll].filter(
                (step): step is DockerUpdaterStepResult => step !== undefined
            );
        }
        const refreshedService = normalizeManagedServiceRow(
            database
                .prepare("SELECT * FROM docker_managed_services WHERE id = ? LIMIT 1")
                .get(serviceId) as ManagedServiceRow | undefined
        );
        if (!refreshedService) {
            return [
                register,
                poll,
                {
                    step: "manual-update",
                    isOk: false,
                    code: "NOT_FOUND",
                    stdout: "",
                    stderr: "Docker updater service not found after registry poll",
                },
            ];
        }
        if (refreshedService.enabled !== 1) {
            return [
                register,
                poll,
                {
                    step: `manual-update:${serviceLabel(refreshedService)}`,
                    isOk: false,
                    code: "DISABLED",
                    stdout: "",
                    stderr: "Docker updater service not found or disabled",
                },
            ];
        }
        if (refreshedService.last_status === "unsupported_registry") {
            return [
                register,
                poll,
                {
                    step: `manual-update:${serviceLabel(refreshedService)}`,
                    isOk: false,
                    code: "UNSUPPORTED_REGISTRY",
                    stdout: "",
                    stderr: `Unsupported image registry: ${imageRegistry(refreshedService.image_repo)}`,
                },
            ];
        }
        if (!hasUpdate(refreshedService)) {
            return [
                register,
                poll,
                {
                    step: `manual-update-skipped:${serviceLabel(refreshedService)}`,
                    isOk: false,
                    code: "CONFLICT",
                    stdout: "No update available after registry poll",
                    stderr: "",
                },
            ];
        }
        protectMutation();
        const apply = await applyServiceUpdate(refreshedService, "manual", signal);
        if (apply.isOk) {
            await pruneDanglingImagesBestEffort(signal);
        }
        const steps = [register, poll, apply];
        await syncDockerUpdaterChangesBestEffort(steps, signal, protectMutation);
        return steps;
    }
    const blockedAppSlugs = failedDiscoveryAppSlugs(register);
    const poll = await pollDockerUpdaterRegistries(undefined, signal);
    const autoServices = normalizeManagedServiceRows(
        database
            .prepare(
                "SELECT * FROM docker_managed_services WHERE enabled = 1 AND policy = 'auto'"
            )
            .all() as unknown as ManagedServiceRow[]
    );
    const applyResults: DockerUpdaterStepResult[] = [];
    for (const service of autoServices) {
        signal?.throwIfAborted();
        if (
            blockedAppSlugs.has(service.app_slug) ||
            service.last_status !== "update_available" ||
            !hasUpdate(service)
        ) {
            continue;
        }
        protectMutation();
        applyResults.push(await applyServiceUpdate(service, "auto", signal));
    }
    if (applyResults.some((step) => step.isOk)) {
        await pruneDanglingImagesBestEffort(signal);
    }
    const steps = [register, poll, ...applyResults];
    await syncDockerUpdaterChangesBestEffort(steps, signal, protectMutation);
    return steps;
}

function preservedTimeOfDay(
    existing: ScheduledJob | undefined,
    fallback: string
): string | undefined {
    if (!existing) {
        return fallback;
    }
    return existing.timeOfDay;
}

export function registerDockerUpdaterScheduledJobs(): void {
    const job = {
        id: "docker.updater",
        name: "Docker updater",
        description: "Poll Docker registries and apply approved automatic updates.",
        scheduleType: "daily",
        intervalSeconds: 24 * 60 * 60,
        timeOfDay: "04:10",
        actionKey: "docker.updater",
        actionPayload: {},
        resourceClass: "exclusive",
    } as const;
    registerScheduledJobAction(
        "docker.updater",
        async (executionJob, signal, context) => {
            const rawServiceId = executionJob.actionPayload.serviceId;
            const serviceId =
                rawServiceId === undefined
                    ? undefined
                    : typeof rawServiceId === "number" &&
                        Number.isSafeInteger(rawServiceId) &&
                        rawServiceId > 0
                      ? rawServiceId
                      : NaN;
            if (Number.isNaN(serviceId)) {
                throw Object.assign(new Error("Invalid Docker updater service id"), {
                    statusCode: 400,
                });
            }
            const steps = await runDockerUpdaterService(
                serviceId,
                signal,
                context.protectFromCancellation
            );
            const failed = steps.filter(
                (step) =>
                    !step.isOk &&
                    !isNonblockingRegistrationFailure(step) &&
                    step.step !== "git-sync:docker"
            );
            if (failed.length > 0) {
                throw new ScheduledJobActionError(
                    failed.map((step) => `${step.step}: ${step.stderr}`).join("\n"),
                    { serviceId, steps }
                );
            }
            return { serviceId, steps };
        },
        { timeoutMs: 30 * 60 * 1000 }
    );
    database.run("BEGIN");
    try {
        removeScheduledJobsNotInAction("docker.updater", [job.id]);
        const existing = getScheduledJob(job.id);
        upsertScheduledJob({
            ...job,
            enabled: existing?.enabled ?? true,
            scheduleType: existing?.scheduleType ?? job.scheduleType,
            intervalSeconds: existing?.intervalSeconds ?? job.intervalSeconds,
            timeOfDay: preservedTimeOfDay(existing, job.timeOfDay),
            cronExpression: existing?.cronExpression ?? undefined,
        });
        database.run("COMMIT");
    } catch (error) {
        database.run("ROLLBACK");
        throw error;
    }
}
