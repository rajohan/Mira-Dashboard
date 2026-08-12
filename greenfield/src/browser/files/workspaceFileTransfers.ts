import * as v from "valibot";

import {
    workspaceFileLimits,
    workspaceFileNameSchema,
    workspaceFileRawHttpContracts,
    workspaceFileUploadAcceptedSchema,
    type WorkspaceFileContentTicket,
    type WorkspaceFileEntry,
    type WorkspaceFileUploadAccepted,
    type WorkspaceFileWriteStatus,
} from "../../contracts/files.ts";
import type { WorkspaceFileClient } from "./workspaceFileClient.ts";
import { WorkspaceFileTransferError } from "./workspaceFilePresentation.ts";

const workspaceFileTransferTimeoutMs = 60_000;

const uploadContract = workspaceFileRawHttpContracts.find(
    ({ method }) => method === "PUT"
);
if (uploadContract?.requestBody.kind !== "binary") {
    throw new TypeError("Workspace file upload contract is unavailable");
}
const supportedUploadMimeTypes = new Set<string>(uploadContract.requestBody.contentTypes);

export interface WorkspaceFilePreparedPreview {
    readonly content?: string;
    readonly revealTicketId?: string;
    readonly secretsRevealed?: true;
    readonly ticket: WorkspaceFileContentTicket;
}

type WorkspaceFileFetch = (
    input: RequestInfo | URL,
    init?: RequestInit
) => Promise<Response>;

function workspaceFileMimeType(file: File, fallback?: string): string {
    const declared = file.type.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (supportedUploadMimeTypes.has(declared)) return declared;
    if (fallback !== undefined && supportedUploadMimeTypes.has(fallback)) {
        return fallback;
    }
    return "application/octet-stream";
}

/**
 * Applies the exact shared filename and transfer-byte budgets before reservation.
 * @param file Browser-selected file.
 * @param validateName Whether the local filename becomes a new workspace child name.
 * @returns One fixed validation message, or undefined when valid.
 */
export function validateWorkspaceFileSelection(
    file: File,
    validateName = true
): string | undefined {
    if (validateName && !v.safeParse(workspaceFileNameSchema, file.name).success) {
        return "Choose a file with a valid literal name.";
    }
    if (file.size > workspaceFileLimits.maximumUploadBytes) {
        return "Choose a file no larger than 16 MiB.";
    }
    return undefined;
}

function transferCategoryForStatus(
    status: number
): WorkspaceFileTransferError["category"] {
    if (status === 409 || status === 412 || status === 416) return "conflict";
    if (status === 410) return "expired";
    if (status === 413) return "too-large";
    if (status === 415) return "unsupported";
    if (status === 429) return "rate-limited";
    if (status >= 400 && status < 500) return "invalid";
    return "unavailable";
}

function transferSignal(signal: AbortSignal): AbortSignal {
    return AbortSignal.any([signal, AbortSignal.timeout(workspaceFileTransferTimeoutMs)]);
}

async function readBoundedText(
    response: Response,
    expectedBytes: number
): Promise<string> {
    if (
        expectedBytes > workspaceFileLimits.maximumTextPreviewBytes ||
        expectedBytes < 0
    ) {
        throw new WorkspaceFileTransferError("too-large");
    }
    const declaredLength = response.headers.get("Content-Length");
    if (
        declaredLength !== null &&
        (!/^\d+$/u.test(declaredLength) || Number(declaredLength) !== expectedBytes)
    ) {
        throw new WorkspaceFileTransferError("protocol");
    }
    const bytes = new Uint8Array(expectedBytes);
    let offset = 0;
    if (response.body === null) throw new WorkspaceFileTransferError("protocol");
    const reader = response.body.getReader();
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (chunk.value.byteLength > expectedBytes - offset) {
                throw new WorkspaceFileTransferError("protocol");
            }
            bytes.set(chunk.value, offset);
            offset += chunk.value.byteLength;
        }
    } finally {
        reader.releaseLock();
    }
    if (offset !== expectedBytes) throw new WorkspaceFileTransferError("protocol");
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        throw new WorkspaceFileTransferError("protocol");
    }
}

function ticketMatchesPreviewKind(ticket: WorkspaceFileContentTicket): boolean {
    switch (ticket.previewKind) {
        case "audio": {
            return ticket.mimeType.startsWith("audio/");
        }
        case "image": {
            return ticket.mimeType.startsWith("image/");
        }
        case "pdf": {
            return ticket.mimeType === "application/pdf";
        }
        case "text": {
            return (
                ticket.mimeType.startsWith("text/") ||
                ticket.mimeType === "application/json"
            );
        }
        case "download-only": {
            return true;
        }
    }
}

function ticketMatchesEntry(
    ticket: WorkspaceFileContentTicket,
    entry: WorkspaceFileEntry
): boolean {
    if (ticket.revision !== entry.revision) return false;
    if (ticket.truncated === true) {
        return (
            entry.truncated === true &&
            entry.sizeBytes !== undefined &&
            ticket.sourceSizeBytes !== undefined &&
            ticket.sourceSizeBytes === entry.sizeBytes &&
            ticket.sourceSizeBytes > ticket.sizeBytes &&
            ticket.sizeBytes <= workspaceFileLimits.maximumTextPreviewBytes
        );
    }
    return entry.truncated !== true && ticket.sourceSizeBytes === undefined;
}

/**
 * Issues a short-lived preview ticket and materializes only bounded UTF-8 text.
 * @param client Files-only validated browser client.
 * @param entry Exact file revision selected by the operator.
 * @param signal Auth-generation-scoped cancellation signal.
 * @param fetcher Injectable same-origin raw transport.
 * @returns Prepared media ticket and optional inert text content.
 */
export async function prepareWorkspaceFilePreview(
    client: WorkspaceFileClient,
    entry: WorkspaceFileEntry,
    signal: AbortSignal,
    fetcher: WorkspaceFileFetch = globalThis.fetch
): Promise<WorkspaceFilePreparedPreview> {
    const ticket = await client.query(
        "files.prepareContent",
        { disposition: "preview", resourceId: entry.resourceId },
        { signal }
    );
    return materializeWorkspaceFilePreview(ticket, entry, signal, fetcher);
}

async function materializeWorkspaceFilePreview(
    ticket: WorkspaceFileContentTicket,
    entry: WorkspaceFileEntry,
    signal: AbortSignal,
    fetcher: WorkspaceFileFetch,
    secretsRevealed = false
): Promise<WorkspaceFilePreparedPreview> {
    if (
        ticket.expiresAtMs <= Date.now() ||
        !ticketMatchesEntry(ticket, entry) ||
        !ticketMatchesPreviewKind(ticket)
    ) {
        throw new WorkspaceFileTransferError("protocol");
    }
    if (ticket.previewKind !== "text") {
        return {
            ...(secretsRevealed
                ? { revealTicketId: ticket.ticketId, secretsRevealed: true as const }
                : {}),
            ticket,
        };
    }

    let response: Response;
    try {
        response = await fetcher(ticket.url, {
            cache: "no-store",
            credentials: "same-origin",
            signal: transferSignal(signal),
        });
    } catch (error) {
        if (signal.aborted) throw error;
        throw new WorkspaceFileTransferError("unavailable");
    }
    if (!response.ok) {
        throw new WorkspaceFileTransferError(transferCategoryForStatus(response.status));
    }
    return {
        content: await readBoundedText(response, ticket.sizeBytes),
        ...(secretsRevealed
            ? { revealTicketId: ticket.ticketId, secretsRevealed: true as const }
            : {}),
        ticket,
    };
}

/**
 * Performs one recent-auth mutation and materializes the raw config only in
 * local component state. Neither the request nor its response enters Query cache.
 * @param client Files-only validated browser client.
 * @param entry Exact masked config revision selected by the operator.
 * @param signal Auth-generation-scoped cancellation signal.
 * @param fetcher Injectable same-origin raw transport.
 * @returns Prepared uncached raw text plus the reveal ticket needed for replacement.
 */
export async function revealWorkspaceFileSecrets(
    client: WorkspaceFileClient,
    entry: WorkspaceFileEntry,
    signal: AbortSignal,
    fetcher: WorkspaceFileFetch = globalThis.fetch
): Promise<WorkspaceFilePreparedPreview> {
    if (entry.requiresSecretReveal !== true) {
        throw new WorkspaceFileTransferError("invalid");
    }
    const ticket = await client.mutation(
        "files.prepareReveal",
        { resourceId: entry.resourceId },
        { signal }
    );
    return materializeWorkspaceFilePreview(ticket, entry, signal, fetcher, true);
}

function activateDownload(ticket: WorkspaceFileContentTicket): void {
    const anchor = document.createElement("a");
    anchor.download = ticket.truncated ? `${ticket.fileName}.prefix` : ticket.fileName;
    anchor.href = ticket.url;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
}

/** Issues and immediately activates one same-origin, disposition-bound download. */
export async function downloadWorkspaceFile(
    client: WorkspaceFileClient,
    entry: WorkspaceFileEntry,
    signal: AbortSignal
): Promise<void> {
    const ticket = await client.query(
        "files.prepareContent",
        { disposition: "download", resourceId: entry.resourceId },
        { signal }
    );
    if (ticket.expiresAtMs <= Date.now() || !ticketMatchesEntry(ticket, entry)) {
        throw new WorkspaceFileTransferError("protocol");
    }
    activateDownload(ticket);
}

async function reconcileWorkspaceFileUpload(
    client: WorkspaceFileClient,
    ticketId: string,
    signal: AbortSignal
): Promise<WorkspaceFileWriteStatus> {
    if (signal.aborted) {
        throw (
            signal.reason ??
            new DOMException("Workspace file upload was aborted", "AbortError")
        );
    }
    try {
        return await client.query("files.getWriteStatus", { ticketId }, { signal });
    } catch (error) {
        if (signal.aborted) throw error;
        throw new WorkspaceFileTransferError("reconciliation-required");
    }
}

async function acceptedUploadResponse(
    response: Response,
    ticketId: string
): Promise<WorkspaceFileUploadAccepted | undefined> {
    if (!response.ok) return undefined;
    const candidate: unknown = await response.json().catch(() => null);
    const parsed = v.safeParse(workspaceFileUploadAcceptedSchema, candidate);
    return parsed.success && parsed.output.ticketId === ticketId
        ? parsed.output
        : undefined;
}

/**
 * Reserves, streams, and reconciles one create or CAS replacement. A transport
 * ambiguity is never redispatched with a new ticket.
 * @param client Files-only validated browser client.
 * @param input Exact create or replacement selection.
 * @param signal Auth-generation-scoped cancellation signal.
 * @param fetcher Injectable same-origin raw transport.
 * @returns Authoritative accepted, pending, or reconciliation-required status.
 */
export async function uploadWorkspaceFile(
    client: WorkspaceFileClient,
    input:
        | Readonly<{ directoryId: string; file: File; kind: "create" }>
        | Readonly<{
              expectedRevision: string;
              file: File;
              kind: "replace";
              mimeType?: string;
              revealTicketId?: string;
              resourceId: string;
          }>,
    signal: AbortSignal,
    fetcher: WorkspaceFileFetch = globalThis.fetch
): Promise<WorkspaceFileWriteStatus> {
    const selectionError = validateWorkspaceFileSelection(
        input.file,
        input.kind === "create"
    );
    if (selectionError !== undefined) {
        throw new WorkspaceFileTransferError(
            input.file.size > workspaceFileLimits.maximumUploadBytes
                ? "too-large"
                : "invalid"
        );
    }
    const mimeType = workspaceFileMimeType(
        input.file,
        input.kind === "replace" ? input.mimeType : undefined
    );
    const ticket =
        input.kind === "create"
            ? await client.mutation(
                  "files.prepareUpload",
                  {
                      directoryId: input.directoryId,
                      fileName: input.file.name,
                      mimeType,
                      sizeBytes: input.file.size,
                  },
                  { signal }
              )
            : await client.mutation(
                  "files.prepareWrite",
                  {
                      expectedRevision: input.expectedRevision,
                      mimeType,
                      ...(input.revealTicketId === undefined
                          ? {}
                          : { revealTicketId: input.revealTicketId }),
                      resourceId: input.resourceId,
                      sizeBytes: input.file.size,
                  },
                  { signal }
              );
    if (ticket.expiresAtMs <= Date.now()) {
        throw new WorkspaceFileTransferError("expired");
    }

    let response: Response;
    try {
        response = await fetcher(ticket.uploadUrl, {
            body: input.file,
            cache: "no-store",
            credentials: "same-origin",
            headers: { "Content-Type": mimeType },
            method: "PUT",
            signal: transferSignal(signal),
        });
    } catch (error) {
        if (signal.aborted) throw error;
        return reconcileWorkspaceFileUpload(client, ticket.ticketId, signal);
    }

    const accepted = await acceptedUploadResponse(response, ticket.ticketId);
    if (accepted !== undefined) {
        return {
            jobRunId: accepted.jobRunId,
            status: "accepted",
            ticketId: accepted.ticketId,
        };
    }
    const reconciled = await reconcileWorkspaceFileUpload(
        client,
        ticket.ticketId,
        signal
    );
    if (reconciled.status === "accepted") return reconciled;
    if (!response.ok) {
        throw new WorkspaceFileTransferError(transferCategoryForStatus(response.status));
    }
    return reconciled;
}
