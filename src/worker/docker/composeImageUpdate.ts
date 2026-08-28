import Fs from "node:fs";
import Path from "node:path";

import {
    linuxRenameExchange,
    type LinuxRenameExchange,
} from "../files/linuxRenameExchange.ts";
import {
    dockerComposeRoot,
    dockerComposeTrustRoot,
    dockerComposeWrapper,
    isDockerComposeContentSha256,
    type DockerComposeDiscoveredService,
} from "./composeDiscovery.ts";
import {
    matchesDockerTagPolicy,
    parseDockerImageReference,
    type DockerImageReference,
} from "./tagPolicy.ts";

const composeConfigDeadlineMs = 30_000;
const composeApplyDeadlineMs = 180_000;
const composeStackUpDeadlineMs = 660_000;
const composeOutputMaximumBytes = 64 * 1024;
const dockerImageIdPattern = /^sha256:[0-9a-f]{64}$/u;

export type DockerComposeImageUpdateFailureReason =
    | "conflict"
    | "invalid-target"
    | "rollback-failed"
    | "unavailable";

export class DockerComposeImageUpdateError extends Error {
    public readonly reason: DockerComposeImageUpdateFailureReason;
    public readonly rollbackCompleted: boolean;

    public constructor(
        reason: DockerComposeImageUpdateFailureReason,
        rollbackCompleted = true,
        cause?: unknown
    ) {
        super(
            "Docker Compose image update failed",
            cause === undefined ? undefined : { cause }
        );
        this.name = "DockerComposeImageUpdateError";
        this.reason = reason;
        this.rollbackCompleted = rollbackCompleted;
    }
}

export interface DockerComposeCommandResult {
    readonly exitCode: number;
    readonly stderrBytes?: number;
    readonly stdoutBytes?: number;
}

export type DockerComposeCommandRunner = (
    executable: typeof dockerComposeWrapper,
    arguments_: readonly string[],
    options: {
        readonly cwd: typeof dockerComposeTrustRoot;
        readonly deadlineMs: number;
        readonly outputMaximumBytes: number;
        readonly signal?: AbortSignal;
    }
) => Promise<DockerComposeCommandResult>;

export type DockerComposeStackReconciler = (signal?: AbortSignal) => Promise<void>;

export async function reconcileDockerComposeStack(
    runCompose: DockerComposeCommandRunner,
    signal?: AbortSignal
): Promise<void> {
    const up = await runCompose(
        dockerComposeWrapper,
        [
            ...fixedComposeArguments,
            "up",
            "--detach",
            "--pull",
            "never",
            "--force-recreate",
            "--wait",
            "--wait-timeout",
            "600",
        ],
        {
            cwd: dockerComposeTrustRoot,
            deadlineMs: composeStackUpDeadlineMs,
            outputMaximumBytes: composeOutputMaximumBytes,
            ...(signal === undefined ? {} : { signal }),
        }
    );
    if (up.exitCode !== 0) throw classifiedFailure("unavailable");
}

export type DockerComposeRevalidationPhase = "pre-update" | "post-rollback";

export interface DockerComposeRevalidatedTarget {
    readonly runtimeImageId: string;
    readonly target: DockerComposeDiscoveredService;
}

export type DockerComposeTargetRevalidator = (
    phase: DockerComposeRevalidationPhase,
    signal?: AbortSignal
) => Promise<DockerComposeRevalidatedTarget>;

export type DockerImageReferenceRestorer = (
    imageId: string,
    imageReference: string,
    signal?: AbortSignal
) => Promise<void>;

export interface DockerComposeImageUpdateCommand {
    readonly expectedContentSha256: string;
    readonly expectedImageReference: string;
    readonly project: string;
    readonly service: string;
    readonly targetImageReference: string;
}

export interface DockerComposeImageUpdaterOptions {
    readonly composePath: string;
    readonly revalidateTarget: DockerComposeTargetRevalidator;
    readonly renameExchange?: LinuxRenameExchange;
    readonly runCompose: DockerComposeCommandRunner;
    readonly restoreImageReference: DockerImageReferenceRestorer;
    readonly trustRoot?: string;
}

export interface DockerComposeImageUpdateResult {
    readonly fromImageReference: string;
    readonly project: string;
    readonly rollback: (signal?: AbortSignal) => Promise<boolean>;
    readonly service: string;
    readonly settle: () => void;
    readonly status: "updated";
    readonly toImageReference: string;
}

interface OpenComposeSource {
    readonly bytes: Buffer;
    readonly contentSha256: string;
    readonly device: bigint;
    readonly group: bigint;
    readonly inode: bigint;
    readonly mode: number;
    readonly owner: bigint;
    readonly path: string;
}

interface LineSpan {
    readonly content: string;
    readonly contentStart: number;
}

function sha256(value: Uint8Array): string {
    return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function classifiedFailure(
    reason: DockerComposeImageUpdateFailureReason,
    cause?: unknown
): DockerComposeImageUpdateError {
    return cause instanceof DockerComposeImageUpdateError
        ? cause
        : new DockerComposeImageUpdateError(reason, true, cause);
}

function abortIfRequested(signal?: AbortSignal): void {
    if (signal?.aborted === true) {
        throw classifiedFailure("unavailable", signal.reason);
    }
}

function canonicalTrustRoot(value: string): string {
    if (!Path.isAbsolute(value) || Path.normalize(value) !== value) {
        throw classifiedFailure("invalid-target");
    }
    try {
        const canonical = Fs.realpathSync(value);
        const stat = Fs.lstatSync(value);
        if (canonical !== value || stat.isSymbolicLink() || !stat.isDirectory()) {
            throw classifiedFailure("invalid-target");
        }
        return canonical;
    } catch (error) {
        throw classifiedFailure("invalid-target", error);
    }
}

function pathContainedBy(root: string, candidate: string): boolean {
    const relative = Path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !Path.isAbsolute(relative));
}

function canonicalComposePath(trustRoot: string, value: string): string {
    if (!Path.isAbsolute(value) || Path.normalize(value) !== value) {
        throw classifiedFailure("invalid-target");
    }
    try {
        const canonical = Fs.realpathSync(value);
        const stat = Fs.lstatSync(value);
        if (
            canonical !== value ||
            !pathContainedBy(trustRoot, canonical) ||
            stat.isSymbolicLink() ||
            !stat.isFile() ||
            stat.nlink !== 1
        ) {
            throw classifiedFailure("invalid-target");
        }
        return canonical;
    } catch (error) {
        throw classifiedFailure("invalid-target", error);
    }
}

function openComposeSource(trustRoot: string, composePath: string): OpenComposeSource {
    const canonicalPath = canonicalComposePath(trustRoot, composePath);
    let fd: number | undefined;
    try {
        fd = Fs.openSync(canonicalPath, Fs.constants.O_RDONLY | Fs.constants.O_NOFOLLOW);
        const before = Fs.fstatSync(fd, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n) {
            throw classifiedFailure("invalid-target");
        }
        const bytes = Fs.readFileSync(fd);
        const after = Fs.fstatSync(fd, { bigint: true });
        const current = Fs.lstatSync(canonicalPath, { bigint: true });
        if (
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            after.dev !== current.dev ||
            after.ino !== current.ino ||
            after.size !== BigInt(bytes.byteLength) ||
            current.isSymbolicLink() ||
            current.nlink !== 1n
        ) {
            throw classifiedFailure("conflict");
        }
        return Object.freeze({
            bytes,
            contentSha256: sha256(bytes),
            device: after.dev,
            group: after.gid,
            inode: after.ino,
            mode: Number(after.mode & 0o7777n),
            owner: after.uid,
            path: canonicalPath,
        });
    } catch (error) {
        throw classifiedFailure("unavailable", error);
    } finally {
        if (fd !== undefined) Fs.closeSync(fd);
    }
}

function textLines(value: string): readonly LineSpan[] {
    const lines: LineSpan[] = [];
    let offset = 0;
    while (offset < value.length) {
        const newline = value.indexOf("\n", offset);
        const rawEnd = newline === -1 ? value.length : newline;
        const contentEnd =
            rawEnd > offset && value[rawEnd - 1] === "\r" ? rawEnd - 1 : rawEnd;
        lines.push({ content: value.slice(offset, contentEnd), contentStart: offset });
        if (newline === -1) break;
        offset = newline + 1;
    }
    if (value.length === 0) return Object.freeze([]);
    return Object.freeze(lines);
}

function indentation(value: string): number {
    return value.match(/^ */u)?.[0].length ?? 0;
}

function blankOrComment(value: string): boolean {
    const trimmed = value.trim();
    return trimmed.length === 0 || trimmed.startsWith("#");
}

function escapeRegExp(value: string): string {
    return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

function findSingleLine(
    lines: readonly LineSpan[],
    predicate: (line: LineSpan, index: number) => boolean
): number {
    const matches = lines.flatMap((line, index) =>
        predicate(line, index) ? [index] : []
    );
    if (matches.length !== 1) throw classifiedFailure("invalid-target");
    return matches[0]!;
}

function firstChildIndent(
    lines: readonly LineSpan[],
    parentIndex: number,
    parentIndent: number,
    endExclusive: number
): number {
    for (let index = parentIndex + 1; index < endExclusive; index += 1) {
        const line = lines[index]!;
        if (blankOrComment(line.content)) continue;
        const indent = indentation(line.content);
        if (indent <= parentIndent) break;
        return indent;
    }
    throw classifiedFailure("invalid-target");
}

function blockEnd(
    lines: readonly LineSpan[],
    startIndex: number,
    parentIndent: number,
    maximum: number
): number {
    for (let index = startIndex + 1; index < maximum; index += 1) {
        const line = lines[index]!;
        if (!blankOrComment(line.content) && indentation(line.content) <= parentIndent) {
            return index;
        }
    }
    return maximum;
}

function replaceExactImageScalar(
    sourceBytes: Buffer,
    serviceName: string,
    expectedImageReference: string,
    targetImageReference: string
): Buffer {
    let source: string;
    try {
        source = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
    } catch (error) {
        throw classifiedFailure("invalid-target", error);
    }
    const lines = textLines(source);
    const servicesIndex = findSingleLine(lines, ({ content }) =>
        /^services\s*:\s*(?:#.*)?$/u.test(content)
    );
    const servicesIndent = indentation(lines[servicesIndex]!.content);
    const servicesEnd = blockEnd(lines, servicesIndex, servicesIndent, lines.length);
    const serviceChildIndent = firstChildIndent(
        lines,
        servicesIndex,
        servicesIndent,
        servicesEnd
    );
    const escapedService = escapeRegExp(serviceName);
    const servicePattern = new RegExp(
        String.raw`^( *)(?:"${escapedService}"|'${escapedService}'|${escapedService})\s*:\s*(?:#.*)?$`,
        "u"
    );
    const serviceIndex = findSingleLine(lines, ({ content }, index) => {
        if (index <= servicesIndex || index >= servicesEnd || blankOrComment(content)) {
            return false;
        }
        const indent = indentation(content);
        if (indent !== serviceChildIndent) return false;
        const match = content.match(servicePattern);
        return match !== null && (match[1]?.length ?? -1) === serviceChildIndent;
    });
    const serviceIndent = indentation(lines[serviceIndex]!.content);
    const serviceEnd = blockEnd(lines, serviceIndex, serviceIndent, servicesEnd);
    const propertyIndent = firstChildIndent(
        lines,
        serviceIndex,
        serviceIndent,
        serviceEnd
    );
    const escapedExpected = escapeRegExp(expectedImageReference);
    const imagePattern = new RegExp(
        String.raw`^( *)(image)(\s*:\s*)(["']?)(${escapedExpected})\4(\s*(?:#.*)?)$`,
        "u"
    );
    const imageIndexes: number[] = [];
    for (let index = serviceIndex + 1; index < serviceEnd; index += 1) {
        const line = lines[index]!;
        if (blankOrComment(line.content)) continue;
        const indent = indentation(line.content);
        if (indent !== propertyIndent) continue;
        const match = line.content.match(imagePattern);
        if (match !== null && (match[1]?.length ?? -1) === propertyIndent) {
            imageIndexes.push(index);
        }
    }
    if (imageIndexes.length !== 1) throw classifiedFailure("conflict");
    const imageLine = lines[imageIndexes[0]!]!;
    const match = imageLine.content.match(imagePattern);
    if (match === null || match.index === undefined) throw classifiedFailure("conflict");
    const prefixLength =
        (match[1]?.length ?? 0) +
        (match[2]?.length ?? 0) +
        (match[3]?.length ?? 0) +
        (match[4]?.length ?? 0);
    const valueStart = imageLine.contentStart + match.index + prefixLength;
    const valueEnd = valueStart + expectedImageReference.length;
    const updated = `${source.slice(0, valueStart)}${targetImageReference}${source.slice(valueEnd)}`;
    return Buffer.from(updated, "utf8");
}

function stageBytes(
    targetPath: string,
    bytes: Uint8Array,
    source: Pick<OpenComposeSource, "group" | "mode" | "owner">
): string {
    const stagePath = Path.join(
        Path.dirname(targetPath),
        `.mira-docker-${crypto.randomUUID()}.stage`
    );
    let fd: number | undefined;
    let committed = false;
    try {
        fd = Fs.openSync(
            stagePath,
            Fs.constants.O_CREAT |
                Fs.constants.O_EXCL |
                Fs.constants.O_WRONLY |
                Fs.constants.O_NOFOLLOW,
            source.mode
        );
        Fs.writeFileSync(fd, bytes);
        Fs.fchmodSync(fd, source.mode);
        const current = Fs.fstatSync(fd, { bigint: true });
        if (current.uid !== source.owner || current.gid !== source.group) {
            Fs.fchownSync(fd, Number(source.owner), Number(source.group));
        }
        Fs.fsyncSync(fd);
        committed = true;
        return stagePath;
    } catch (error) {
        throw classifiedFailure("unavailable", error);
    } finally {
        if (fd !== undefined) Fs.closeSync(fd);
        if (!committed) {
            try {
                Fs.unlinkSync(stagePath);
            } catch {
                // Preserve the classified staging failure.
            }
        }
    }
}

function fsyncDirectory(directory: string): void {
    const fd = Fs.openSync(directory, Fs.constants.O_RDONLY | Fs.constants.O_DIRECTORY);
    try {
        Fs.fsyncSync(fd);
    } finally {
        Fs.closeSync(fd);
    }
}

function sameSourceIdentity(
    expected: OpenComposeSource,
    current: OpenComposeSource
): boolean {
    return (
        expected.path === current.path &&
        expected.device === current.device &&
        expected.inode === current.inode &&
        expected.contentSha256 === current.contentSha256
    );
}

function targetMatchesCommand(
    target: DockerComposeDiscoveredService,
    command: DockerComposeImageUpdateCommand,
    composePath: string
): boolean {
    return (
        target.enabled &&
        target.composePath === composePath &&
        target.project === command.project &&
        target.service === command.service &&
        target.imageReference === command.expectedImageReference &&
        target.contentSha256 === command.expectedContentSha256
    );
}

function replacementMatchesTarget(
    target: DockerComposeDiscoveredService,
    replacement: DockerImageReference
): boolean {
    return (
        target.image !== undefined &&
        replacement.name === target.image.name &&
        replacement.tag !== undefined &&
        target.tagPolicy !== undefined &&
        matchesDockerTagPolicy(target.tagPolicy, replacement.tag) &&
        ((target.pinMode === "digest" && replacement.digest !== undefined) ||
            (target.pinMode === "tag" && replacement.digest === undefined))
    );
}

const fixedComposeArguments = Object.freeze([
    "--file",
    dockerComposeRoot,
    "--project-directory",
    dockerComposeTrustRoot,
] as const);

async function runRequiredCompose(
    runner: DockerComposeCommandRunner,
    arguments_: readonly string[],
    deadlineMs: number,
    signal?: AbortSignal
): Promise<void> {
    let result: DockerComposeCommandResult;
    try {
        result = await runner(dockerComposeWrapper, arguments_, {
            cwd: dockerComposeTrustRoot,
            deadlineMs,
            outputMaximumBytes: composeOutputMaximumBytes,
            ...(signal === undefined ? {} : { signal }),
        });
    } catch (error) {
        throw classifiedFailure("unavailable", error);
    }
    if (
        !Number.isSafeInteger(result.exitCode) ||
        result.exitCode !== 0 ||
        (result.stdoutBytes !== undefined &&
            result.stdoutBytes > composeOutputMaximumBytes) ||
        (result.stderrBytes !== undefined &&
            result.stderrBytes > composeOutputMaximumBytes)
    ) {
        throw classifiedFailure("unavailable");
    }
}

async function validateCompose(
    runner: DockerComposeCommandRunner,
    signal?: AbortSignal
): Promise<void> {
    await runRequiredCompose(
        runner,
        [...fixedComposeArguments, "config", "--quiet"],
        composeConfigDeadlineMs,
        signal
    );
}

async function applyService(
    runner: DockerComposeCommandRunner,
    service: string,
    pull: "always" | "never",
    forceRecreate: boolean,
    signal?: AbortSignal
): Promise<void> {
    await runRequiredCompose(
        runner,
        [
            ...fixedComposeArguments,
            "up",
            "--detach",
            "--wait",
            "--wait-timeout",
            "150",
            "--pull",
            pull,
            ...(forceRecreate ? ["--force-recreate"] : []),
            "--no-deps",
            service,
        ],
        composeApplyDeadlineMs,
        signal
    );
}

function exchangeSiblings(
    stagePath: string,
    targetPath: string,
    renameExchange: LinuxRenameExchange
): void {
    const directory = Path.dirname(targetPath);
    if (Path.dirname(stagePath) !== directory) {
        throw classifiedFailure("invalid-target");
    }
    const directoryFd = Fs.openSync(
        directory,
        Fs.constants.O_RDONLY | Fs.constants.O_DIRECTORY
    );
    try {
        renameExchange(directoryFd, Path.basename(stagePath), Path.basename(targetPath));
        Fs.fsyncSync(directoryFd);
    } finally {
        Fs.closeSync(directoryFd);
    }
}

function publishSourceCas(
    trustRoot: string,
    stagePath: string,
    targetPath: string,
    expectedOriginal: OpenComposeSource,
    renameExchange: LinuxRenameExchange
): void {
    exchangeSiblings(stagePath, targetPath, renameExchange);
    try {
        const displaced = openComposeSource(trustRoot, stagePath);
        if (!sameSourceIdentity(expectedOriginal, { ...displaced, path: targetPath })) {
            throw classifiedFailure("conflict");
        }
    } catch (error) {
        try {
            exchangeSiblings(stagePath, targetPath, renameExchange);
        } catch (restoreError) {
            throw new DockerComposeImageUpdateError(
                "rollback-failed",
                false,
                restoreError
            );
        }
        throw classifiedFailure("conflict", error);
    }
}

async function rollbackUpdate(input: {
    readonly applyWasAttempted: boolean;
    readonly command: DockerComposeImageUpdateCommand;
    readonly composePath: string;
    readonly expectedRuntimeImageId: string;
    readonly original: OpenComposeSource;
    readonly revalidateTarget: DockerComposeTargetRevalidator;
    readonly restoreImageReference: DockerImageReferenceRestorer;
    readonly runCompose: DockerComposeCommandRunner;
    readonly stagePath: string;
    readonly service: string;
    readonly trustRoot: string;
    readonly updatedSha256: string;
    readonly renameExchange: LinuxRenameExchange;
    readonly signal?: AbortSignal;
}): Promise<boolean> {
    try {
        exchangeSiblings(input.stagePath, input.composePath, input.renameExchange);
        const displaced = openComposeSource(input.trustRoot, input.stagePath);
        if (displaced.contentSha256 !== input.updatedSha256) {
            exchangeSiblings(input.stagePath, input.composePath, input.renameExchange);
            return false;
        }
        await validateCompose(input.runCompose, input.signal);
        if (input.applyWasAttempted) {
            const originalImage = parseDockerImageReference(
                input.command.expectedImageReference
            );
            if (originalImage === undefined) return false;
            if (originalImage.digest === undefined) {
                await input.restoreImageReference(
                    input.expectedRuntimeImageId,
                    input.command.expectedImageReference,
                    input.signal
                );
            }
            await applyService(
                input.runCompose,
                input.service,
                "never",
                true,
                input.signal
            );
        }
        const restoredSource = openComposeSource(input.trustRoot, input.composePath);
        const restored = await input.revalidateTarget("post-rollback", input.signal);
        if (
            restoredSource.contentSha256 !== input.original.contentSha256 ||
            !targetMatchesCommand(restored.target, input.command, input.composePath) ||
            restored.runtimeImageId !== input.expectedRuntimeImageId
        ) {
            return false;
        }
        return true;
    } catch {
        return false;
    } finally {
        try {
            Fs.unlinkSync(input.stagePath);
            fsyncDirectory(Path.dirname(input.stagePath));
        } catch {
            // The sanitized rollback result remains authoritative.
        }
    }
}

function appliedUpdateSettlement(input: {
    readonly command: DockerComposeImageUpdateCommand;
    readonly composePath: string;
    readonly expectedRuntimeImageId: string;
    readonly original: OpenComposeSource;
    readonly revalidateTarget: DockerComposeTargetRevalidator;
    readonly restoreImageReference: DockerImageReferenceRestorer;
    readonly runCompose: DockerComposeCommandRunner;
    readonly service: string;
    readonly trustRoot: string;
    readonly updatedSha256: string;
    readonly renameExchange: LinuxRenameExchange;
}): Pick<DockerComposeImageUpdateResult, "rollback" | "settle"> {
    let material: typeof input | undefined = input;
    return Object.freeze({
        async rollback(signal?: AbortSignal): Promise<boolean> {
            const current = material;
            if (current === undefined) return false;
            material = undefined;
            let stagePath: string;
            try {
                stagePath = stageBytes(
                    current.composePath,
                    current.original.bytes,
                    current.original
                );
            } catch {
                return false;
            }
            return await rollbackUpdate({
                applyWasAttempted: true,
                command: current.command,
                composePath: current.composePath,
                expectedRuntimeImageId: current.expectedRuntimeImageId,
                original: current.original,
                revalidateTarget: current.revalidateTarget,
                restoreImageReference: current.restoreImageReference,
                runCompose: current.runCompose,
                service: current.service,
                stagePath,
                trustRoot: current.trustRoot,
                updatedSha256: current.updatedSha256,
                renameExchange: current.renameExchange,
                ...(signal === undefined ? {} : { signal }),
            });
        },
        settle(): void {
            material = undefined;
        },
    });
}

/**
 * @param command Reviewed source-CAS update intent.
 * @param options Fixed worker adapters and discovered source owner.
 * @param signal Optional job cancellation signal.
 * @returns A sanitized successful-update projection.
 */
export async function updateDockerComposeImage(
    command: DockerComposeImageUpdateCommand,
    options: DockerComposeImageUpdaterOptions,
    signal?: AbortSignal
): Promise<DockerComposeImageUpdateResult> {
    abortIfRequested(signal);
    const expectedImage = parseDockerImageReference(command.expectedImageReference);
    const targetImage = parseDockerImageReference(command.targetImageReference);
    if (
        !isDockerComposeContentSha256(command.expectedContentSha256) ||
        command.project.length === 0 ||
        command.project.length > 128 ||
        command.service.length === 0 ||
        command.service.length > 128 ||
        expectedImage === undefined ||
        targetImage === undefined ||
        targetImage.name !== expectedImage.name ||
        command.expectedImageReference === command.targetImageReference
    ) {
        throw classifiedFailure("invalid-target");
    }
    const trustRoot = canonicalTrustRoot(options.trustRoot ?? dockerComposeTrustRoot);
    const renameExchange = options.renameExchange ?? linuxRenameExchange;
    const composePath = canonicalComposePath(trustRoot, options.composePath);
    const firstRevalidation = await options
        .revalidateTarget("pre-update", signal)
        .catch((error: unknown) => {
            throw classifiedFailure("unavailable", error);
        });
    const firstTarget = firstRevalidation.target;
    if (
        !dockerImageIdPattern.test(firstRevalidation.runtimeImageId) ||
        !targetMatchesCommand(firstTarget, command, composePath) ||
        !replacementMatchesTarget(firstTarget, targetImage)
    ) {
        throw classifiedFailure("conflict");
    }
    const original = openComposeSource(trustRoot, composePath);
    if (original.contentSha256 !== command.expectedContentSha256) {
        throw classifiedFailure("conflict");
    }
    const updatedBytes = replaceExactImageScalar(
        original.bytes,
        command.service,
        command.expectedImageReference,
        command.targetImageReference
    );
    const updatedSha256 = sha256(updatedBytes);
    let stagePath = stageBytes(composePath, updatedBytes, original);
    let published = false;
    let applyWasAttempted = false;
    try {
        abortIfRequested(signal);
        const secondRevalidation = await options
            .revalidateTarget("pre-update", signal)
            .catch((error: unknown) => {
                throw classifiedFailure("unavailable", error);
            });
        const secondTarget = secondRevalidation.target;
        const reopened = openComposeSource(trustRoot, composePath);
        if (
            secondRevalidation.runtimeImageId !== firstRevalidation.runtimeImageId ||
            !targetMatchesCommand(secondTarget, command, composePath) ||
            !replacementMatchesTarget(secondTarget, targetImage) ||
            !sameSourceIdentity(original, reopened)
        ) {
            throw classifiedFailure("conflict");
        }
        publishSourceCas(trustRoot, stagePath, composePath, original, renameExchange);
        published = true;
        await validateCompose(options.runCompose, signal);
        applyWasAttempted = true;
        await applyService(options.runCompose, command.service, "always", false, signal);
        Fs.unlinkSync(stagePath);
        fsyncDirectory(Path.dirname(stagePath));
        stagePath = "";
        const settlement = appliedUpdateSettlement({
            command,
            composePath,
            expectedRuntimeImageId: firstRevalidation.runtimeImageId,
            original,
            revalidateTarget: options.revalidateTarget,
            restoreImageReference: options.restoreImageReference,
            runCompose: options.runCompose,
            service: command.service,
            trustRoot,
            updatedSha256,
            renameExchange,
        });
        return Object.freeze({
            fromImageReference: command.expectedImageReference,
            project: command.project,
            ...settlement,
            service: command.service,
            status: "updated",
            toImageReference: command.targetImageReference,
        });
    } catch (error) {
        const failure = classifiedFailure(
            error instanceof DockerComposeImageUpdateError ? error.reason : "unavailable",
            error
        );
        if (!published) throw failure;
        const rollbackStagePath = stagePath;
        stagePath = "";
        const rollbackCompleted = await rollbackUpdate({
            applyWasAttempted,
            command,
            composePath,
            expectedRuntimeImageId: firstRevalidation.runtimeImageId,
            original,
            revalidateTarget: options.revalidateTarget,
            restoreImageReference: options.restoreImageReference,
            runCompose: options.runCompose,
            stagePath: rollbackStagePath,
            service: command.service,
            trustRoot,
            updatedSha256,
            renameExchange,
        });
        if (!rollbackCompleted) {
            throw new DockerComposeImageUpdateError("rollback-failed", false, failure);
        }
        throw failure;
    } finally {
        if (stagePath !== "") {
            try {
                Fs.unlinkSync(stagePath);
            } catch {
                // The original classified result remains authoritative.
            }
        }
    }
}
