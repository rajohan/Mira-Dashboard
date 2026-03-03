import { spawn } from "child_process";
import express, { type RequestHandler } from "express";

interface ExecRequest {
    command: string;
    args?: string[];
    cwd?: string;
}

interface ExecResponse {
    code: number | null;
    stdout: string;
    stderr: string;
}

export default function execRoutes(
    app: express.Application,
    _express: typeof express
): void {
    app.post("/api/exec", express.json(), (async (req, res) => {
        const { command, args, cwd } = req.body as ExecRequest;

        // Support both formats:
        // 1. { command: "ls -la" } - shell command string
        // 2. { command: "gh", args: ["issue", "list"] } - command with args array

        try {
            const child =
                args && Array.isArray(args)
                    ? spawn(command, args, {
                          cwd: cwd || process.cwd(),
                          env: process.env,
                      })
                    : spawn(command, {
                          shell: true,
                          cwd: cwd || process.cwd(),
                          env: process.env,
                      });

            let stdout = "";
            let stderr = "";

            child.stdout.on("data", (data) => {
                stdout += data;
            });
            child.stderr.on("data", (data) => {
                stderr += data;
            });

            child.on("close", (code) => {
                res.json({
                    code: code,
                    stdout: stdout.slice(-10000),
                    stderr: stderr.slice(-10000),
                } satisfies ExecResponse);
            });

            child.on("error", (e) => {
                res.status(500).json({ error: e.message });
            });
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);
}
