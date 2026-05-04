import express, { type RequestHandler } from "express";

import gateway from "../gateway.js";

interface ConfigGetResponse {
    parsed?: Record<string, unknown>;
    hash?: string;
}

async function getConfigSnapshot(): Promise<ConfigGetResponse> {
    const response = (await gateway.request("config.get", {})) as ConfigGetResponse;
    return response;
}

async function patchConfig(patch: Record<string, unknown>): Promise<unknown> {
    const snapshot = await getConfigSnapshot();
    if (!snapshot.hash) {
        throw new Error("OpenClaw config hash unavailable");
    }

    return gateway.request("config.patch", {
        raw: JSON.stringify(patch),
        baseHash: snapshot.hash,
        note: "Updated from Mira Dashboard settings",
    });
}

function getSkills(config: Record<string, unknown> | undefined) {
    const skills = config?.skills as { entries?: Record<string, unknown> } | undefined;
    const entries = skills?.entries || {};

    return Object.entries(entries)
        .map(([name, value]) => {
            const entry = (value || {}) as { enabled?: boolean; description?: string };
            return {
                name,
                path: `skills.entries.${name}`,
                enabled: entry.enabled !== false,
                description: entry.description,
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

export default function openClawConfigRoutes(app: express.Application): void {
    app.get("/api/config", (async (_req, res) => {
        try {
            const snapshot = await getConfigSnapshot();
            res.json({ ...(snapshot.parsed || {}), __hash: snapshot.hash });
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    app.put("/api/config", express.json(), (async (req, res) => {
        try {
            const result = await patchConfig(req.body as Record<string, unknown>);
            res.json({ ok: true, result });
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    app.get("/api/skills", (async (_req, res) => {
        try {
            const snapshot = await getConfigSnapshot();
            res.json({ skills: getSkills(snapshot.parsed) });
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    app.post("/api/skills/:name", express.json(), (async (req, res) => {
        try {
            const name = String(req.params.name || "");
            const enabled = Boolean((req.body as { enabled?: boolean }).enabled);

            if (!name) {
                res.status(400).json({ error: "Skill name required" });
                return;
            }

            await patchConfig({
                skills: {
                    entries: {
                        [name]: { enabled },
                    },
                },
            });
            res.json({ ok: true });
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);
}
