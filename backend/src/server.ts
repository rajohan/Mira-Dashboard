import { execSync } from "node:child_process";

import dotenv from "dotenv";
import express from "express";
import rateLimit from "express-rate-limit";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocket, WebSocketServer } from "ws";

import { getAuthUserFromRequest, requireAuth } from "./auth.ts";
import gateway from "./gateway.ts";
import agentsRoutes from "./routes/agents.ts";
import authRoutes from "./routes/auth.ts";
import backupRoutes from "./routes/backups.ts";
import cacheRoutes from "./routes/cache.ts";
import configFilesRoutes from "./routes/configFiles.ts";
import cronRoutes from "./routes/cron.ts";
import databaseRoutes from "./routes/database.ts";
import dockerRoutes from "./routes/docker.ts";
import execRoutes from "./routes/exec.ts";
import filesRoutes from "./routes/files.ts";
import jobsRoutes from "./routes/jobs.ts";
import logsRoutes from "./routes/logs.ts";
import mediaRoutes from "./routes/media.ts";
import metricsRoutes from "./routes/metrics.ts";
import moltbookRoutes from "./routes/moltbook.ts";
import notificationsRoutes from "./routes/notifications.ts";
import openClawConfigRoutes from "./routes/openclawConfig.ts";
import opsRoutes from "./routes/ops.ts";
import pullRequestsRoutes from "./routes/pullRequests.ts";
import sessionsRoutes from "./routes/sessions.ts";
import settingsRoutes from "./routes/settings.ts";
import staticRoutes from "./routes/static.ts";
import sttRoutes from "./routes/stt.ts";
import tasksRoutes from "./routes/tasks.ts";
import terminalRoutes from "./routes/terminal.ts";
import ttsRoutes from "./routes/tts.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const app = express();
const GLOBAL_JSON_LIMIT = "2097152b";
const globalJsonParser = express.json({ limit: GLOBAL_JSON_LIMIT });

export function shouldSkipGlobalJsonParser(
    request: Pick<express.Request, "method" | "path">
): boolean {
    return (
        (request.method === "PATCH" && /^\/api\/jobs\/[^/]+\/?$/u.test(request.path)) ||
        (request.method === "PUT" && request.path.startsWith("/api/config-files/")) ||
        (request.method === "PUT" && request.path.startsWith("/api/files/"))
    );
}

/** Parses Express trust-proxy config from environment strings. */
export function parseTrustProxy(value?: string): boolean | number | string {
    if (value === undefined || value.trim() === "") {
        return "loopback";
    }

    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;

    if (/^\d+$/u.test(normalized)) {
        const parsed = Number(normalized);
        if (Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 255) {
            return parsed;
        }
        return "loopback";
    }

    return normalized;
}

export const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const frontendPath =
    process.env.MIRA_DASHBOARD_FRONTEND_PATH || path.join(__dirname, "..", "..", "dist");

type ExecSyncCommand = (
    command: string,
    options: Parameters<typeof execSync>[1]
) => Buffer | string;

/** Resolves the current backend Git commit for health responses. */
export function resolveBackendCommit(
    repoRoot = path.join(__dirname, "..", ".."),
    execCommand: ExecSyncCommand = execSync
): string {
    try {
        return execCommand("git rev-parse --short HEAD", {
            cwd: repoRoot,
            stdio: ["ignore", "pipe", "ignore"],
        })
            .toString()
            .trim();
    } catch {
        return "unknown";
    }
}

const backendCommit = resolveBackendCommit();

/** Resolves the port the backend should listen on. */
export function resolveListenPort(value = process.env.PORT): number {
    const trimmed = value?.trim() ?? "";
    if (!/^\d+$/u.test(trimmed)) {
        return 3100;
    }

    const port = Number(trimmed);
    return port <= 65_535 ? port : 3100;
}

// =====================
// API Routes
// =====================

/** Performs health handler. */
const healthHandler: express.RequestHandler = (_request, response) => {
    response.json({
        status: "isOk",
        gatewayConnected: gateway.isConnected(),
        sessionCount: gateway.getSessions().length,
        backendCommit,
    });
};

/** Returns whether an API-relative path belongs to the auth route tree. */
export function isAuthRoute(pathname: string): boolean {
    return pathname === "/auth" || pathname.startsWith("/auth/");
}

// Rate limiting: general API (600 req/min per IP). This intentionally stays
// above normal dashboard polling (terminal jobs poll every 500ms) while still
// bounding abusive request bursts.
const apiLimiter = rateLimit({
    windowMs: 60_000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (request) => isAuthRoute(request.path),
    message: { error: "Too many requests, please try again later" },
});

// Stricter limit for auth endpoints (20 req/min per IP)
const authLimiter = rateLimit({
    windowMs: 60_000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many authentication attempts, please try again later" },
});

/** Returns dashboard sessions for authenticated requests. */
export const sessionsHandler: express.RequestHandler = (request, response) => {
    const user = getAuthUserFromRequest(request);
    if (!user) {
        response.status(401).json({ error: "Unauthorized" });
        return;
    }

    response.json(gateway.getSessions());
};

/** Applies API auth while leaving auth bootstrap/login routes public. */
export const apiAuthMiddleware: express.RequestHandler = (request, response, next) => {
    if (isAuthRoute(request.path)) {
        next();
        return;
    }
    requireAuth(request, response, next);
};

// =====================
// WebSocket
// =====================
/** Handles one dashboard WebSocket connection after authenticating the request. */
export function handleWebSocketConnection(
    ws: WebSocket,
    request: http.IncomingMessage
): void {
    const user = getAuthUserFromRequest(request);
    if (!user) {
        ws.close(4401, "Unauthorized");
        return;
    }

    gateway.handleClient(ws);
}

function shouldConfigureServerModule(): true {
    dotenv.config();
    app.set("trust proxy", parseTrustProxy(process.env.TRUST_PROXY));
    app.use((request, response, next) => {
        if (shouldSkipGlobalJsonParser(request)) {
            next();
            return;
        }

        globalJsonParser(request, response, next);
    });

    app.get("/health", healthHandler);
    app.get("/api/health", healthHandler);

    // Apply rate limiting before auth middleware
    app.use("/api/auth", authLimiter);
    app.use("/api", apiLimiter);
    app.get("/api/sessions", sessionsHandler);

    authRoutes(app);
    app.use("/api", apiAuthMiddleware);

    // Route modules
    filesRoutes(app, express);
    configFilesRoutes(app, express);
    cacheRoutes(app);
    backupRoutes(app, express);
    agentsRoutes(app);
    logsRoutes(app);
    cronRoutes(app);
    databaseRoutes(app);
    dockerRoutes(app);
    execRoutes(app, express);
    jobsRoutes(app);
    openClawConfigRoutes(app);
    mediaRoutes(app);
    metricsRoutes(app);
    moltbookRoutes(app);
    settingsRoutes(app, express, gateway.getStatus);
    sessionsRoutes(app);
    sttRoutes(app, express);
    tasksRoutes(app, express);
    ttsRoutes(app, express);
    notificationsRoutes(app);
    opsRoutes(app);
    pullRequestsRoutes(app);
    terminalRoutes(app);

    // Static files & SPA (must be last)
    staticRoutes(app, frontendPath);

    wss.on("connection", handleWebSocketConnection);
    return true;
}

export const isServerModuleConfigured = shouldConfigureServerModule();
