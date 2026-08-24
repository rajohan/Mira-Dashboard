import type {
    WorkerPtyFactory,
    WorkerPtyHandle,
    WorkerPtyRequest,
} from "./terminalSessionBroker.ts";

const prompt = "mira-dev> ";
const maximumBufferedCommandBytes = 4096;
const encoder = new TextEncoder();

function output(request: WorkerPtyRequest, text: string): void {
    if (request.callbacks.onOutput(encoder.encode(text)) === "backpressured") {
        request.callbacks.onOutputBackpressure();
    }
}

/**
 * Creates a process-free source-development terminal profile. It implements the
 * production PTY broker protocol and lifecycle states but never launches a host
 * process, reads credentials, mounts production paths, or retains Docker/systemd
 * authority. Commands are explicit simulator verbs only.
 * @param request Broker-owned terminal request and callbacks.
 * @returns A process-free PTY-compatible simulator handle.
 */
export const createDevelopmentPtyProcess: WorkerPtyFactory = (
    request: WorkerPtyRequest
): WorkerPtyHandle => {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const exit = Promise.withResolvers<{
        readonly exitCode: number;
        readonly signalCode: NodeJS.Signals | null;
    }>();
    let closed = false;
    let pending = "";

    const settle = (signalCode: NodeJS.Signals | null = null) => {
        if (!closed) {
            closed = true;
            exit.resolve(Object.freeze({ exitCode: 0, signalCode }));
        }
        return exit.promise;
    };
    const processLine = (raw: string): void => {
        const command = raw.trim();
        if (command === "" || command === "help") {
            output(
                request,
                "Source-development terminal simulator. Commands: help, profile, pwd, clear, exit.\r\n"
            );
        } else if (command === "profile") {
            output(request, "profile=isolated-simulator authority=none\r\n");
        } else if (command === "pwd") {
            output(request, "/workspace\r\n");
        } else if (command === "clear") {
            output(request, "\u001B[2J\u001B[H");
        } else if (command === "exit" || command === "logout") {
            output(request, "logout\r\n");
            void settle();
            return;
        } else {
            output(
                request,
                `unsupported simulated command: ${command.slice(0, 256)}\r\n`
            );
        }
        if (!closed) output(request, prompt);
    };

    queueMicrotask(() => {
        if (!closed) {
            output(
                request,
                "Mira Dashboard isolated source-development terminal (no host shell).\r\n"
            );
            output(request, prompt);
        }
    });

    const handle: WorkerPtyHandle = {
        exited: exit.promise,
        resize() {
            // Dimensions are validated by the shared broker. The simulator has no PTY.
        },
        sendSignal(signal) {
            return closed
                ? Promise.resolve("closed" as const)
                : settle(signal).then(() => "sent" as const);
        },
        terminate: () => settle("SIGTERM"),
        writeInput(data) {
            if (closed) {
                return Object.freeze({ acceptedBytes: 0, status: "closed" as const });
            }
            if (data.byteLength === 0 || data.byteLength > maximumBufferedCommandBytes) {
                return Object.freeze({
                    acceptedBytes: 0,
                    status: "backpressured" as const,
                });
            }
            let text: string;
            try {
                text = decoder.decode(data, { stream: true });
            } catch {
                void settle("SIGTERM");
                return Object.freeze({ acceptedBytes: 0, status: "closed" as const });
            }
            pending += text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
            if (Buffer.byteLength(pending, "utf8") > maximumBufferedCommandBytes) {
                void settle("SIGTERM");
                return Object.freeze({ acceptedBytes: 0, status: "closed" as const });
            }
            const lines = pending.split("\n");
            pending = lines.pop() ?? "";
            for (const line of lines) {
                if (closed) break;
                processLine(line);
            }
            return Object.freeze({
                acceptedBytes: data.byteLength,
                status: "accepted" as const,
            });
        },
    };
    return Object.freeze(handle);
};
