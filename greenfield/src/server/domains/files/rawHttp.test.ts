import { afterEach, describe, expect, test } from "bun:test";
import Fs from "node:fs";
import Os from "node:os";
import Path from "node:path";

import type { AuthenticatedPrincipal } from "../../../contracts/security.ts";
import { createDescriptorWorkspaceFileReader } from "../../platform/files/descriptorWorkspaceFileReader.ts";
import { createDescriptorWorkspaceFileUploadSpool } from "../../platform/files/descriptorWorkspaceFileUploadSpool.ts";
import { dashboardSessionCookieName } from "../../rawHttp/authenticationCredentials.ts";
import type { WorkspaceFileWriteScheduler } from "./ports.ts";
import {
    createWorkspaceFileRawHttpHandler,
    type WorkspaceFileRawHttpHandler,
} from "./rawHttp.ts";
import {
    createWorkspaceFilesService,
    type WorkspaceFileActor,
    type WorkspaceFilesService,
} from "./service.ts";

const origin = "https://dashboard.example.test";
const sessionToken = `${"0".repeat(32)}.${"1".repeat(64)}`;
const userId = "019fe633-9133-7ba0-8b80-809dd80dfb40";
const sessionId = "0".repeat(32);
const fileActor: WorkspaceFileActor = { authenticatorId: sessionId, id: userId };
const temporaryDirectories: string[] = [];
const services: WorkspaceFilesService[] = [];

function uuid(index: number): string {
    return `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function principal(
    capabilities: AuthenticatedPrincipal["capabilities"] = ["files:read", "files:write"],
    overrides: Partial<AuthenticatedPrincipal> = {}
): AuthenticatedPrincipal {
    return {
        authorizationVersion: 1,
        authenticatorId: sessionId,
        capabilities,
        id: userId,
        kind: "session",
        ...overrides,
    };
}

function authentication(principalValue: AuthenticatedPrincipal) {
    return () => ({
        authentication: { kind: "authenticated" as const, principal: principalValue },
        lease: {
            expiresAtMs: 4_000_000_000_000_000,
            revalidate: () => Promise.resolve(),
        },
    });
}

function request(path: string, init: RequestInit = {}, requestOrigin = origin): Request {
    const headers = new Headers(init.headers);
    headers.set("cookie", `${dashboardSessionCookieName}=${sessionToken}`);
    headers.set("origin", requestOrigin);
    headers.set(
        "sec-fetch-site",
        requestOrigin === origin ? "same-origin" : "cross-site"
    );
    return new Request(`${origin}${path}`, { ...init, headers });
}

function fixture(
    options: {
        readonly authorization?: "authorized" | "step-up-required";
        readonly principal?: AuthenticatedPrincipal;
        readonly scheduler?: Partial<WorkspaceFileWriteScheduler>;
    } = {}
) {
    const parent = Fs.mkdtempSync(Path.join(Os.tmpdir(), "mira-files-raw-"));
    const root = Path.join(parent, "workspace");
    const spoolRoot = Path.join(parent, "spool");
    Fs.mkdirSync(root, { mode: 0o700 });
    Fs.mkdirSync(spoolRoot, { mode: 0o700 });
    temporaryDirectories.push(parent);
    let nextId = 1;
    let now = 1_800_000_000_000;
    const commands: Parameters<WorkspaceFileWriteScheduler["enqueue"]>[0][] = [];
    const scheduler: WorkspaceFileWriteScheduler = {
        enqueue(command) {
            commands.push(command);
            return Promise.resolve({
                acceptedAtMs: now,
                jobRunId: "job-raw-1",
                ticketId: command.ticketId,
            });
        },
        getStatus() {
            return Promise.resolve(undefined);
        },
        listActiveSpoolIds() {
            return Promise.resolve({ spoolIds: [], truncated: false });
        },
        ...options.scheduler,
    };
    const service = createWorkspaceFilesService({
        generateId: () => uuid(nextId++),
        nowMs: () => now,
        reader: createDescriptorWorkspaceFileReader({
            roots: [
                {
                    id: "workspace",
                    label: "Workspace",
                    path: root,
                    writable: true,
                },
            ],
        }),
        scheduler,
        spool: createDescriptorWorkspaceFileUploadSpool(spoolRoot, {
            nowMs: () => now,
        }),
    });
    services.push(service);
    const handler = createWorkspaceFileRawHttpHandler({
        authenticateCredential: authentication(options.principal ?? principal()),
        authorizeWrite: () => options.authorization ?? "authorized",
        browserOrigin: origin,
        generateRequestId: () => "raw-request-1",
        service,
    });
    return {
        commands,
        handler,
        root,
        service,
        setNow(value: number) {
            now = value;
        },
        spoolRoot,
    };
}

async function response(
    handler: WorkspaceFileRawHttpHandler,
    incoming: Request
): Promise<Response> {
    const result = await handler(incoming, new URL(incoming.url));
    if (result === undefined) throw new Error("Expected files handler response");
    return result;
}

async function status(
    handler: WorkspaceFileRawHttpHandler,
    incoming: Request
): Promise<number> {
    const outgoing = await response(handler, incoming);
    return outgoing.status;
}

async function listedFile(service: WorkspaceFilesService, root: string) {
    Fs.writeFileSync(Path.join(root, "notes.txt"), "abcdef");
    const roots = await service.listRoots(fileActor);
    const page = await service.list(fileActor, {
        directoryId: roots.roots[0]!.resourceId,
        limit: 10,
    });
    return { directoryId: roots.roots[0]!.resourceId, file: page.entries[0]! };
}

afterEach(async () => {
    await Promise.allSettled(services.splice(0).map((service) => service.dispose()));
    for (const directory of temporaryDirectories.splice(0)) {
        Fs.rmSync(directory, { force: true, recursive: true });
    }
});

describe("workspace files raw HTTP boundary", () => {
    test("publishes exact method boundaries before authentication", async () => {
        const { handler } = fixture();
        const content = await response(
            handler,
            request(`/api/files/content/${uuid(400)}`, { method: "PUT" })
        );
        expect(content.status).toBe(405);
        expect(content.headers.get("allow")).toBe("GET, HEAD");

        const upload = await response(
            handler,
            request(`/api/files/uploads/${uuid(401)}`, { method: "GET" })
        );
        expect(upload.status).toBe(405);
        expect(upload.headers.get("allow")).toBe("PUT");
    });

    test("serves ticket-bound GET, HEAD, and one exact byte range with hardened headers", async () => {
        const { handler, root, service } = fixture();
        const { file } = await listedFile(service, root);
        const ticket = await service.prepareContent(fileActor, {
            disposition: "preview",
            resourceId: file.resourceId,
        });

        const full = await response(handler, request(ticket.url));
        expect(full.status).toBe(200);
        expect(await full.text()).toBe("abcdef");
        expect(full.headers.get("content-type")).toBe("text/plain");
        expect(full.headers.get("content-security-policy")).toContain("sandbox");
        expect(full.headers.get("content-disposition")).toStartWith("inline;");
        expect(full.headers.get("cache-control")).toBe("private, no-store");

        const partial = await response(
            handler,
            request(ticket.url, { headers: { range: "bytes=2-4" } })
        );
        expect(partial.status).toBe(206);
        expect(await partial.text()).toBe("cde");
        expect(partial.headers.get("content-range")).toBe("bytes 2-4/6");

        const head = await response(
            handler,
            request(ticket.url, { method: "HEAD", headers: { range: "bytes=-2" } })
        );
        expect(head.status).toBe(206);
        expect(head.headers.get("content-length")).toBe("2");
        expect(await head.text()).toBe("");

        const invalidRange = await response(
            handler,
            request(ticket.url, { headers: { range: "bytes=0-1,3-4" } })
        );
        expect(invalidRange.status).toBe(416);
        expect(invalidRange.headers.get("content-range")).toBe("bytes */6");
    });

    test("fails closed for cross-origin, capability, actor, stale, and expired tickets", async () => {
        const base = fixture();
        const { file } = await listedFile(base.service, base.root);
        const ticket = await base.service.prepareContent(fileActor, {
            disposition: "download",
            resourceId: file.resourceId,
        });

        expect(
            await status(
                base.handler,
                request(ticket.url, {}, "https://attacker.example.test")
            )
        ).toBe(403);
        const noRead = fixture({ principal: principal(["files:write"]) });
        expect(await status(noRead.handler, request(ticket.url))).toBe(403);
        const otherSessionHandler = createWorkspaceFileRawHttpHandler({
            authenticateCredential: authentication(
                principal(undefined, { authenticatorId: "1".repeat(32) })
            ),
            authorizeWrite: () => "authorized",
            browserOrigin: origin,
            service: base.service,
        });
        expect(await status(otherSessionHandler, request(ticket.url))).toBe(404);

        Fs.writeFileSync(Path.join(base.root, "notes.txt"), "changed");
        expect(await status(base.handler, request(ticket.url))).toBe(409);
        base.setNow(ticket.expiresAtMs);
        expect(await status(base.handler, request(ticket.url))).toBe(410);
    });

    test("accepts one exact recent-MFA upload and rejects replay or declaration drift", async () => {
        const { commands, handler, root, service, spoolRoot } = fixture();
        const roots = await service.listRoots(fileActor);
        const ticket = await service.prepareUpload(fileActor, {
            directoryId: roots.roots[0]!.resourceId,
            fileName: "new.txt",
            mimeType: "text/plain",
            sizeBytes: 5,
        });
        const upload = request(ticket.uploadUrl, {
            body: "hello",
            headers: { "content-length": "5", "content-type": "text/plain" },
            method: "PUT",
        });
        const accepted = await response(handler, upload);
        expect(accepted.status).toBe(202);
        expect(await accepted.json()).toEqual({
            acceptedAtMs: 1_800_000_000_000,
            jobRunId: "job-raw-1",
            ticketId: ticket.ticketId,
        });
        expect(commands).toHaveLength(1);
        expect(Fs.readdirSync(spoolRoot)).toHaveLength(1);
        expect(Fs.existsSync(Path.join(root, "new.txt"))).toBe(false);

        const retry = await response(
            handler,
            request(ticket.uploadUrl, {
                body: "hello",
                headers: { "content-length": "5", "content-type": "text/plain" },
                method: "PUT",
            })
        );
        expect(retry.status).toBe(409);
        expect(commands).toHaveLength(1);

        const next = await service.prepareUpload(fileActor, {
            directoryId: roots.roots[0]!.resourceId,
            fileName: "other.txt",
            mimeType: "text/plain",
            sizeBytes: 5,
        });
        expect(
            await status(
                handler,
                request(next.uploadUrl, {
                    body: "hello",
                    headers: {
                        "content-length": "4",
                        "content-type": "text/plain",
                    },
                    method: "PUT",
                })
            )
        ).toBe(409);
        expect(
            await status(
                handler,
                request(next.uploadUrl, {
                    body: "hello",
                    headers: {
                        "content-length": "5",
                        "content-type": "image/png",
                    },
                    method: "PUT",
                })
            )
        ).toBe(409);
    });

    test("requires write capability, current session MFA, content length, and supported MIME", async () => {
        const base = fixture();
        const roots = await base.service.listRoots(fileActor);
        const ticket = await base.service.prepareUpload(fileActor, {
            directoryId: roots.roots[0]!.resourceId,
            fileName: "guarded.txt",
            mimeType: "text/plain",
            sizeBytes: 1,
        });
        const noWrite = fixture({ principal: principal(["files:read"]) });
        expect(
            await status(
                noWrite.handler,
                request(ticket.uploadUrl, {
                    body: "x",
                    headers: { "content-length": "1", "content-type": "text/plain" },
                    method: "PUT",
                })
            )
        ).toBe(403);
        const staleMfa = createWorkspaceFileRawHttpHandler({
            authenticateCredential: authentication(principal()),
            authorizeWrite: () => "step-up-required",
            browserOrigin: origin,
            service: base.service,
        });
        expect(
            await status(
                staleMfa,
                request(ticket.uploadUrl, {
                    body: "x",
                    headers: { "content-length": "1", "content-type": "text/plain" },
                    method: "PUT",
                })
            )
        ).toBe(403);
        expect(
            await status(
                base.handler,
                request(ticket.uploadUrl, {
                    body: "x",
                    headers: { "content-type": "text/plain" },
                    method: "PUT",
                })
            )
        ).toBe(411);
        expect(
            await status(
                base.handler,
                request(ticket.uploadUrl, {
                    body: "x",
                    headers: {
                        "content-length": "1",
                        "content-type": "application/x-executable",
                    },
                    method: "PUT",
                })
            )
        ).toBe(415);
    });
});
