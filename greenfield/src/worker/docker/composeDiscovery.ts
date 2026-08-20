import Fs from "node:fs";
import Path from "node:path";

import {
    createDockerTagPolicy,
    parseDockerImageReference,
    type DockerImageReference,
    type DockerTagPolicy,
} from "./tagPolicy.ts";

export const dockerComposeRoot = "/opt/docker/compose.yaml" as const;
export const dockerComposeTrustRoot = "/opt/docker" as const;
export const dockerComposeWrapper = "/opt/docker/bin/docker-compose-doppler" as const;
export const dockerComposeDiscoveryLimits = Object.freeze({
    aggregateBytes: 2 * 1024 * 1024,
    files: 64,
    includeDepth: 8,
});

const updaterLabelKeys = Object.freeze([
    "mira.updater.enabled",
    "mira.updater.autoUpdate",
    "mira.updater.track",
    "mira.updater.tagPattern",
    "mira.updater.tagPatternIsRegex",
] as const);
type UpdaterLabelKey = (typeof updaterLabelKeys)[number];
const backupLabelKeys = Object.freeze(["mira.dashboard.backup"] as const);
type BackupLabelKey = (typeof backupLabelKeys)[number];
type ProjectedLabelKey = UpdaterLabelKey | BackupLabelKey;
const projectedLabelKeySet: ReadonlySet<string> = new Set([
    ...updaterLabelKeys,
    ...backupLabelKeys,
]);
const sha256Pattern = /^[0-9a-f]{64}$/u;
const identityPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;

export interface DockerEngineComposeIdentity {
    readonly configFiles: readonly string[];
    readonly project: string;
    readonly service: string;
}

export interface DockerComposeDiscoveredService {
    readonly autoUpdate: boolean;
    readonly composePath: string;
    readonly configFiles: readonly string[];
    readonly contentSha256: string;
    readonly enabled: boolean;
    readonly image?: DockerImageReference;
    readonly imageReference: string;
    readonly labels: Readonly<Partial<Record<ProjectedLabelKey, string>>>;
    readonly pinMode: "digest" | "tag";
    readonly project: string;
    readonly service: string;
    readonly sourceAmbiguous?: true;
    readonly tagPolicy?: DockerTagPolicy;
}

export interface DockerComposeDiscoveryResult {
    readonly composeFiles: readonly string[];
    readonly services: readonly DockerComposeDiscoveredService[];
    readonly sourceRevision: string;
}

export interface DockerComposeDiscoveryOptions {
    readonly aggregateMaximumBytes?: number;
    readonly fileMaximum?: number;
    readonly includeDepthMaximum?: number;
    readonly rootComposePath?: string;
    readonly trustRoot?: string;
}

export class DockerComposeDiscoveryError extends Error {
    public constructor(cause?: unknown) {
        super(
            "Docker Compose discovery failed",
            cause === undefined ? undefined : { cause }
        );
        this.name = "DockerComposeDiscoveryError";
    }
}

interface LoadedComposeFile {
    readonly bytes: Buffer;
    readonly device: bigint;
    readonly document: Record<string, unknown>;
    readonly group: bigint;
    readonly inode: bigint;
    readonly mode: bigint;
    readonly owner: bigint;
    readonly path: string;
    readonly sha256: string;
}

function fail(cause?: unknown): never {
    throw cause instanceof DockerComposeDiscoveryError
        ? cause
        : new DockerComposeDiscoveryError(cause);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: Uint8Array): string {
    return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function compareText(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function canonicalTrustRoot(value: string): string {
    if (!Path.isAbsolute(value) || Path.normalize(value) !== value) fail();
    const canonical = Fs.realpathSync(value);
    const stat = Fs.lstatSync(value);
    if (canonical !== value || stat.isSymbolicLink() || !stat.isDirectory()) fail();
    return canonical;
}

function pathContainedBy(root: string, candidate: string): boolean {
    const relative = Path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !Path.isAbsolute(relative));
}

function canonicalComposeFile(trustRoot: string, value: string): string {
    if (!Path.isAbsolute(value) || Path.normalize(value) !== value) fail();
    const canonical = Fs.realpathSync(value);
    const stat = Fs.lstatSync(value);
    if (
        canonical !== value ||
        !pathContainedBy(trustRoot, canonical) ||
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        stat.nlink !== 1
    ) {
        fail();
    }
    return canonical;
}

function includePaths(document: Record<string, unknown>): readonly string[] {
    const rawInclude = document.include;
    if (rawInclude === undefined) return Object.freeze([]);
    if (!Array.isArray(rawInclude)) fail();
    const paths: string[] = [];
    for (const entry of rawInclude) {
        if (typeof entry === "string") {
            paths.push(entry);
            continue;
        }
        if (!isRecord(entry) || Object.keys(entry).some((key) => key !== "path")) fail();
        const rawPath = entry.path;
        if (typeof rawPath === "string") {
            paths.push(rawPath);
            continue;
        }
        if (
            Array.isArray(rawPath) &&
            rawPath.length > 0 &&
            rawPath.every((value): value is string => typeof value === "string")
        ) {
            paths.push(...rawPath);
            continue;
        }
        fail();
    }
    return Object.freeze(paths);
}

function safeIncludePath(baseDirectory: string, rawPath: string): string {
    if (
        rawPath.length === 0 ||
        rawPath.includes("\0") ||
        rawPath.includes("\\") ||
        rawPath.includes("$") ||
        /[\p{Cc}\p{Cf}]/u.test(rawPath)
    ) {
        fail();
    }
    return Path.resolve(baseDirectory, rawPath);
}

function parseComposeDocument(bytes: Buffer): Record<string, unknown> {
    let document: unknown;
    try {
        document = Bun.YAML.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        );
    } catch (error) {
        fail(error);
    }
    if (!isRecord(document)) fail();
    return document;
}

function readCanonicalComposeFile(
    trustRoot: string,
    requestedPath: string,
    maximumBytes: number
): Omit<LoadedComposeFile, "document" | "sha256"> {
    const composePath = canonicalComposeFile(trustRoot, requestedPath);
    let fd: number | undefined;
    try {
        fd = Fs.openSync(composePath, Fs.constants.O_RDONLY | Fs.constants.O_NOFOLLOW);
        const before = Fs.fstatSync(fd, { bigint: true });
        if (
            !before.isFile() ||
            before.nlink !== 1n ||
            before.size < 0n ||
            before.size > BigInt(maximumBytes)
        ) {
            fail();
        }
        const bytes = Buffer.alloc(Number(before.size));
        let offset = 0;
        while (offset < bytes.byteLength) {
            const read = Fs.readSync(fd, bytes, offset, bytes.byteLength - offset, null);
            if (read === 0) fail();
            offset += read;
        }
        if (Fs.readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0) fail();
        const after = Fs.fstatSync(fd, { bigint: true });
        const current = Fs.lstatSync(composePath, { bigint: true });
        if (
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            before.size !== after.size ||
            after.dev !== current.dev ||
            after.ino !== current.ino ||
            current.isSymbolicLink() ||
            current.nlink !== 1n
        ) {
            fail();
        }
        return Object.freeze({
            bytes,
            device: after.dev,
            group: after.gid,
            inode: after.ino,
            mode: after.mode,
            owner: after.uid,
            path: composePath,
        });
    } finally {
        if (fd !== undefined) Fs.closeSync(fd);
    }
}

function loadComposeGraph(
    options: DockerComposeDiscoveryOptions
): readonly LoadedComposeFile[] {
    const trustRoot = canonicalTrustRoot(options.trustRoot ?? dockerComposeTrustRoot);
    const rootPath = canonicalComposeFile(
        trustRoot,
        options.rootComposePath ?? dockerComposeRoot
    );
    const fileMaximum = options.fileMaximum ?? dockerComposeDiscoveryLimits.files;
    const depthMaximum =
        options.includeDepthMaximum ?? dockerComposeDiscoveryLimits.includeDepth;
    const aggregateMaximum =
        options.aggregateMaximumBytes ?? dockerComposeDiscoveryLimits.aggregateBytes;
    if (
        !Number.isSafeInteger(fileMaximum) ||
        fileMaximum < 1 ||
        fileMaximum > dockerComposeDiscoveryLimits.files ||
        !Number.isSafeInteger(depthMaximum) ||
        depthMaximum < 0 ||
        depthMaximum > dockerComposeDiscoveryLimits.includeDepth ||
        !Number.isSafeInteger(aggregateMaximum) ||
        aggregateMaximum < 1 ||
        aggregateMaximum > dockerComposeDiscoveryLimits.aggregateBytes
    ) {
        fail();
    }

    const loaded = new Map<string, LoadedComposeFile>();
    let aggregateBytes = 0;
    const visit = (requestedPath: string, depth: number): void => {
        if (depth > depthMaximum) fail();
        const canonicalPath = canonicalComposeFile(trustRoot, requestedPath);
        if (loaded.has(canonicalPath)) return;
        if (loaded.size >= fileMaximum) fail();
        const remainingBytes = aggregateMaximum - aggregateBytes;
        const source = readCanonicalComposeFile(trustRoot, canonicalPath, remainingBytes);
        const { bytes, path: composePath } = source;
        aggregateBytes += bytes.byteLength;
        if (aggregateBytes > aggregateMaximum) fail();
        const document = parseComposeDocument(bytes);
        loaded.set(
            composePath,
            Object.freeze({
                ...source,
                document,
                sha256: sha256(bytes),
            })
        );
        for (const includePath of includePaths(document)) {
            visit(safeIncludePath(Path.dirname(composePath), includePath), depth + 1);
        }
    };
    visit(rootPath, 0);
    return Object.freeze([...loaded.values()]);
}

function normalizeLabels(rawLabels: unknown): {
    readonly isValid: boolean;
    readonly values: ReadonlyMap<string, string>;
} {
    const labels = new Map<string, string>();
    let isValid = true;
    const add = (key: string, rawValue: unknown): void => {
        if (!projectedLabelKeySet.has(key)) return;
        if (
            typeof rawValue !== "string" ||
            labels.has(key) ||
            rawValue.length > 256 ||
            /[\p{Cc}\p{Cf}]/u.test(rawValue)
        ) {
            isValid = false;
            return;
        }
        labels.set(key, rawValue.replaceAll("$$", "$"));
    };
    if (Array.isArray(rawLabels)) {
        for (const entry of rawLabels) {
            if (typeof entry !== "string") {
                isValid = false;
                continue;
            }
            const separator = entry.indexOf("=");
            add(
                separator === -1 ? entry : entry.slice(0, separator),
                separator === -1 ? "" : entry.slice(separator + 1)
            );
        }
    } else if (isRecord(rawLabels)) {
        for (const [key, value] of Object.entries(rawLabels)) add(key, value);
    } else if (rawLabels !== undefined) {
        isValid = false;
    }
    return Object.freeze({ isValid, values: labels });
}

function validIdentity(identity: DockerEngineComposeIdentity): boolean {
    return (
        identityPattern.test(identity.project) &&
        identityPattern.test(identity.service) &&
        identity.configFiles.length > 0 &&
        identity.configFiles.length <= dockerComposeDiscoveryLimits.files &&
        identity.configFiles.every((path) => typeof path === "string")
    );
}

function exactBoolean(
    labels: ReadonlyMap<string, string>,
    key: UpdaterLabelKey
): boolean {
    return labels.get(key) === "true";
}

function composeServiceNames(graph: readonly LoadedComposeFile[]): readonly string[] {
    const names = new Set<string>();
    for (const file of graph) {
        const services = file.document.services;
        if (services === undefined) continue;
        if (!isRecord(services)) fail();
        for (const service of Object.keys(services)) {
            if (!identityPattern.test(service)) fail();
            names.add(service);
        }
    }
    return Object.freeze([...names].toSorted(compareText));
}

function composeProject(
    identities: readonly DockerEngineComposeIdentity[],
    rootComposePath: string
): string {
    const observedProjects = new Set<string>();
    for (const identity of identities) {
        if (!validIdentity(identity)) fail();
        observedProjects.add(identity.project);
    }
    if (observedProjects.size > 1) fail();
    const project =
        observedProjects.values().next().value ??
        Path.basename(Path.dirname(rootComposePath));
    if (!identityPattern.test(project)) fail();
    return project;
}

function rootGraphIdentities(
    identities: readonly DockerEngineComposeIdentity[],
    graph: readonly LoadedComposeFile[],
    rootComposePath: string,
    serviceNames: ReadonlySet<string>
): readonly DockerEngineComposeIdentity[] {
    const graphPaths = new Set(graph.map(({ path }) => path));
    const relevant: DockerEngineComposeIdentity[] = [];
    for (const identity of identities) {
        const pathsAreCanonical = identity.configFiles.every(
            (path) => Path.isAbsolute(path) && Path.normalize(path) === path
        );
        const belongsToRootGraph =
            pathsAreCanonical &&
            identity.configFiles.includes(rootComposePath) &&
            identity.configFiles.every((path) => graphPaths.has(path));
        if (!belongsToRootGraph || !serviceNames.has(identity.service)) continue;
        if (!validIdentity(identity)) fail();
        relevant.push(identity);
    }
    return Object.freeze(
        relevant.toSorted(
            (left, right) =>
                compareText(left.project, right.project) ||
                compareText(left.service, right.service)
        )
    );
}

function composeSourceRevision(
    graph: readonly LoadedComposeFile[],
    identities: readonly DockerEngineComposeIdentity[],
    services: readonly DockerComposeDiscoveredService[],
    rootComposePath: string
): string {
    const projection = Object.freeze({
        files: graph
            .map(
                ({ device, group, inode, mode, owner, path, sha256: contentSha256 }) => ({
                    contentSha256,
                    device: device.toString(10),
                    group: group.toString(10),
                    inode: inode.toString(10),
                    mode: mode.toString(10),
                    owner: owner.toString(10),
                    path,
                })
            )
            .toSorted((left, right) => compareText(left.path, right.path)),
        identities: identities.map(({ configFiles, project, service }) => ({
            configFiles: [...configFiles].toSorted(compareText),
            project,
            service,
        })),
        owners: services.map(
            ({ composePath, configFiles, project, service, sourceAmbiguous }) => ({
                composePath,
                configFiles: [...configFiles].toSorted(compareText),
                project,
                service,
                sourceAmbiguous: sourceAmbiguous === true,
            })
        ),
        rootComposePath,
    });
    return sha256(Buffer.from(JSON.stringify(projection)));
}

function discoveredService(
    identity: DockerEngineComposeIdentity,
    graph: readonly LoadedComposeFile[]
): DockerComposeDiscoveredService | undefined {
    if (!validIdentity(identity)) fail();
    const graphByPath = new Map(graph.map((file) => [file.path, file]));
    const configuredPaths = new Set(
        identity.configFiles.map((value) => {
            if (!Path.isAbsolute(value) || Path.normalize(value) !== value) fail();
            const canonical = Fs.realpathSync(value);
            if (!graphByPath.has(canonical)) fail();
            return canonical;
        })
    );
    const owners: Array<{
        readonly file: LoadedComposeFile;
        readonly imageReference: string;
        readonly labels: ReadonlyMap<string, string>;
        readonly labelsAreValid: boolean;
    }> = [];
    for (const file of graph) {
        const services = file.document.services;
        if (!isRecord(services) || !Object.hasOwn(services, identity.service)) continue;
        const service = services[identity.service];
        if (!isRecord(service)) fail();
        if (typeof service.image !== "string") continue;
        const normalizedLabels = normalizeLabels(service.labels);
        owners.push({
            file,
            imageReference: service.image,
            labels: normalizedLabels.values,
            labelsAreValid: normalizedLabels.isValid,
        });
    }
    if (owners.length === 0) return undefined;
    const orderedOwners = owners.toSorted((left, right) =>
        compareText(left.file.path, right.file.path)
    );
    const owner = orderedOwners[0]!;
    const sourceAmbiguous = orderedOwners.length !== 1;
    if (
        owner.imageReference.length === 0 ||
        owner.imageReference.length > 512 ||
        !/\S/u.test(owner.imageReference) ||
        /[\p{Cc}\p{Cf}]/u.test(owner.imageReference)
    ) {
        fail();
    }
    const image = parseDockerImageReference(owner.imageReference);
    if (sourceAmbiguous) {
        return Object.freeze({
            autoUpdate: false,
            composePath: owner.file.path,
            configFiles: Object.freeze([...configuredPaths].toSorted()),
            contentSha256: owner.file.sha256,
            enabled: false,
            imageReference: owner.imageReference,
            labels: Object.freeze({}),
            pinMode: image?.digest === undefined ? "tag" : "digest",
            project: identity.project,
            service: identity.service,
            sourceAmbiguous: true,
        });
    }
    const enabledRequested = exactBoolean(owner.labels, "mira.updater.enabled");
    const enabledLabel = owner.labels.get("mira.updater.enabled");
    const autoUpdateLabel = owner.labels.get("mira.updater.autoUpdate");
    const booleansAreValid =
        (enabledLabel === undefined ||
            enabledLabel === "true" ||
            enabledLabel === "false") &&
        (autoUpdateLabel === undefined ||
            autoUpdateLabel === "true" ||
            autoUpdateLabel === "false");
    const track = owner.labels.get("mira.updater.track");
    const trackIsValid = track === undefined || track === "digest" || track === "tag";
    const patternIsRegexLabel = owner.labels.get("mira.updater.tagPatternIsRegex");
    const patternIsRegexIsValid =
        patternIsRegexLabel === undefined ||
        patternIsRegexLabel === "true" ||
        patternIsRegexLabel === "false";
    const pattern = owner.labels.get("mira.updater.tagPattern");
    const tagPolicy = createDockerTagPolicy({
        currentTag:
            image?.tag ??
            (image !== undefined && image.digest === undefined ? "latest" : undefined),
        pattern,
        patternIsRegex: patternIsRegexLabel !== "false",
    });
    const enabled =
        enabledRequested &&
        image !== undefined &&
        owner.labelsAreValid &&
        booleansAreValid &&
        trackIsValid &&
        patternIsRegexIsValid &&
        tagPolicy !== undefined;
    const autoUpdate = enabled && exactBoolean(owner.labels, "mira.updater.autoUpdate");
    const labels = Object.freeze(
        owner.labelsAreValid
            ? (Object.fromEntries(owner.labels) as Partial<
                  Record<ProjectedLabelKey, string>
              >)
            : {}
    );
    let pinMode: "digest" | "tag";
    if (track === "digest" || track === "tag") {
        pinMode = track;
    } else {
        pinMode = image?.digest === undefined ? "tag" : "digest";
    }
    return Object.freeze({
        autoUpdate,
        composePath: owner.file.path,
        configFiles: Object.freeze([...configuredPaths].toSorted()),
        contentSha256: owner.file.sha256,
        enabled,
        ...(image === undefined ? {} : { image }),
        imageReference: owner.imageReference,
        labels,
        pinMode,
        project: identity.project,
        service: identity.service,
        ...(tagPolicy === undefined ? {} : { tagPolicy }),
    });
}

/**
 * @param engineIdentities Dynamic Compose identities projected from Docker Engine.
 * @param options Fixed-root overrides used by isolated tests.
 * @returns The bounded include graph and joined service projections.
 */
export function discoverDockerComposeServices(
    engineIdentities: readonly DockerEngineComposeIdentity[],
    options: DockerComposeDiscoveryOptions = {}
): DockerComposeDiscoveryResult {
    try {
        if (engineIdentities.length > 256) fail();
        const graph = loadComposeGraph(options);
        const rootComposePath = graph[0]?.path;
        if (rootComposePath === undefined) fail();
        const serviceNames = new Set(composeServiceNames(graph));
        const relevantIdentities = rootGraphIdentities(
            engineIdentities,
            graph,
            rootComposePath,
            serviceNames
        );
        const project = composeProject(relevantIdentities, rootComposePath);
        const observedByService = new Map<string, DockerEngineComposeIdentity>();
        for (const identity of relevantIdentities) {
            if (identity.project !== project) fail();
            const existing = observedByService.get(identity.service);
            if (
                existing !== undefined &&
                JSON.stringify(existing.configFiles) !==
                    JSON.stringify(identity.configFiles)
            ) {
                fail();
            }
            observedByService.set(identity.service, identity);
        }
        const services: DockerComposeDiscoveredService[] = [];
        for (const serviceName of [...serviceNames].toSorted(compareText)) {
            const identity =
                observedByService.get(serviceName) ??
                Object.freeze({
                    configFiles: Object.freeze([rootComposePath]),
                    project,
                    service: serviceName,
                });
            const service = discoveredService(identity, graph);
            if (service !== undefined) services.push(service);
        }
        services.sort(
            (left, right) =>
                compareText(left.project, right.project) ||
                compareText(left.service, right.service) ||
                compareText(left.composePath, right.composePath)
        );
        const composeFiles = Object.freeze(graph.map((file) => file.path).toSorted());
        const frozenServices = Object.freeze(services);
        return Object.freeze({
            composeFiles,
            services: frozenServices,
            sourceRevision: composeSourceRevision(
                graph,
                relevantIdentities,
                frozenServices,
                rootComposePath
            ),
        });
    } catch (error) {
        fail(error);
    }
}

/**
 * @param value Candidate source digest.
 * @returns Whether it is one canonical SHA-256 digest.
 */
export function isDockerComposeContentSha256(value: string): boolean {
    return sha256Pattern.test(value);
}
