import { execSync } from "node:child_process";
import express, { type RequestHandler } from "express";

interface OpenRouterQuota {
    usage: number;
    totalCredits: number;
    remaining: number;
    usageMonthly: number;
    percentUsed: number | null;
}

interface ElevenLabsQuota {
    used: number;
    total: number;
    remaining: number;
    tier: string;
    percentUsed: number | null;
    resetAt: string | null;
}

interface ZaiQuota {
    level: string;
    fiveHour: {
        usedPercentage: number;
        resetAt: string;
    };
    weekly: {
        usedPercentage: number;
        resetAt: string;
    };
}

interface OpenAiQuota {
    account: string | null;
    model: string | null;
    fiveHourLeftPercent: number;
    weeklyLeftPercent: number;
    fiveHourReset: string | null;
    weeklyReset: string | null;
    percentUsed: number;
    resetAt: string | null;
}

export interface QuotasResponse {
    openrouter: OpenRouterQuota | { status: "not_configured" | "error"; note?: string };
    elevenlabs: ElevenLabsQuota | { status: "not_configured" | "error"; note?: string };
    zai: ZaiQuota | { status: "not_configured" | "error"; note?: string };
    openai: OpenAiQuota | { status: "not_configured" | "error"; note?: string };
    checkedAt: number;
    cacheAgeMs: number;
}

const CACHE_TTL_MS = 15 * 60 * 1000;
let cache: { value: QuotasResponse; fetchedAt: number } | null = null;
let quotasFetchInFlight: Promise<QuotasResponse> | null = null;
const secretCache = new Map<string, string | null>();

function readSecretFromDoppler(name: string): string | null {
    if (secretCache.has(name)) {
        return secretCache.get(name) ?? null;
    }

    try {
        const value = execSync(`/usr/local/bin/doppler secrets get ${name} --plain`, {
            stdio: ["ignore", "pipe", "ignore"],
            encoding: "utf8",
        }).trim();
        const result = value || null;
        if (result) {
            secretCache.set(name, result);
        }
        return result;
    } catch {
        return null;
    }
}

function getSecret(name: string): string | null {
    const value = process.env[name];
    if (value && value.trim()) {
        return value;
    }

    return readSecretFromDoppler(name);
}

function toNumber(value: unknown, fallback = 0): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
    const response = await fetch(url, { headers });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
}

async function checkOpenRouter(): Promise<QuotasResponse["openrouter"]> {
    const apiKey = getSecret("OPENROUTER_API_KEY");
    if (!apiKey) return { status: "not_configured" };

    try {
        const [keyInfo, creditsInfo] = await Promise.all([
            fetchJson("https://openrouter.ai/api/v1/key", {
                Authorization: `Bearer ${apiKey}`,
            }) as Promise<{ data?: { usage?: number; usage_monthly?: number } }>,
            fetchJson("https://openrouter.ai/api/v1/credits", {
                Authorization: `Bearer ${apiKey}`,
            }) as Promise<{ data?: { total_credits?: number } }>,
        ]);

        const usage = toNumber(keyInfo?.data?.usage);
        const totalCredits = toNumber(creditsInfo?.data?.total_credits);
        const remaining = Math.max(totalCredits - usage, 0);
        const usageMonthly = toNumber(keyInfo?.data?.usage_monthly);
        const percentUsed = totalCredits > 0 ? Math.round((usage / totalCredits) * 100) : null;

        return {
            usage,
            totalCredits,
            remaining,
            usageMonthly,
            percentUsed,
        };
    } catch (error) {
        return { status: "error", note: (error as Error).message };
    }
}

async function checkElevenLabs(): Promise<QuotasResponse["elevenlabs"]> {
    const apiKey = getSecret("ELEVENLABS_API_KEY");
    if (!apiKey) return { status: "not_configured" };

    try {
        const data = (await fetchJson("https://api.elevenlabs.io/v1/user", {
            "xi-api-key": apiKey,
        })) as {
            subscription?: {
                character_count?: number;
                character_limit?: number;
                tier?: string;
                next_character_count_reset_unix?: number;
                next_character_count_reset_unix_ms?: number;
            };
        };

        const used = toNumber(data.subscription?.character_count);
        const total = toNumber(data.subscription?.character_limit);
        const remaining = Math.max(total - used, 0);
        const percentUsed = total > 0 ? Math.round((used / total) * 100) : null;

        const resetMsCandidate = Number(data.subscription?.next_character_count_reset_unix_ms);
        const resetSecCandidate = Number(data.subscription?.next_character_count_reset_unix);
        const resetAt = Number.isFinite(resetMsCandidate)
            ? new Date(resetMsCandidate).toISOString()
            : Number.isFinite(resetSecCandidate)
              ? new Date(resetSecCandidate * 1000).toISOString()
              : null;

        return {
            used,
            total,
            remaining,
            tier: data.subscription?.tier || "unknown",
            percentUsed,
            resetAt,
        };
    } catch (error) {
        return { status: "error", note: (error as Error).message };
    }
}

async function checkZai(): Promise<QuotasResponse["zai"]> {
    const apiKey = getSecret("ZAI_API_KEY");
    if (!apiKey) return { status: "not_configured" };

    try {
        const data = (await fetchJson("https://api.z.ai/api/monitor/usage/quota/limit", {
            Authorization: `Bearer ${apiKey}`,
            Refer: "https://z.ai",
        })) as {
            data?: {
                level?: string;
                limits?: Array<{
                    type?: string;
                    unit?: number;
                    number?: number;
                    percentage?: number;
                    nextResetTime?: number;
                }>;
            };
        };

        const limits = (data.data?.limits || []).filter((entry) => entry.type === "TOKENS_LIMIT");
        const fiveHour = limits.find((entry) => entry.unit === 3 && entry.number === 5);
        const weekly = limits.find((entry) => entry.unit === 6 && entry.number === 1);

        // Format reset time
        const formatReset = (timestamp: number | undefined): string => {
            if (!timestamp) return "unknown";
            return new Date(timestamp).toISOString();
        };

        // Calculate next 5-hour window reset
        // Z.ai resets every 5 hours from midnight UTC, so windows are: 00:00, 05:00, 10:00, 15:00, 20:00
        const calculate5hReset = (): string => {
            if (fiveHour?.nextResetTime) {
                return formatReset(fiveHour.nextResetTime);
            }
            
            // Calculate next 5-hour window from now
            const now = new Date();
            const hours = now.getUTCHours();
            
            // Find next 5-hour boundary (00, 05, 10, 15, 20)
            const currentWindow = Math.floor(hours / 5);
            const nextWindow = (currentWindow + 1) % 5;
            const nextWindowHour = nextWindow * 5;
            
            const resetTime = new Date(now);
            resetTime.setUTCHours(nextWindowHour, 0, 0, 0);
            
            // If we're past the last window (20:00-00:00), next reset is at 00:00 next day
            if (hours >= 20) {
                resetTime.setUTCDate(resetTime.getUTCDate() + 1);
                resetTime.setUTCHours(0, 0, 0, 0);
            }
            
            return resetTime.toISOString();
        };

        return {
            level: data.data?.level || "unknown",
            fiveHour: {
                usedPercentage: toNumber(fiveHour?.percentage),
                resetAt: calculate5hReset(),
            },
            weekly: {
                usedPercentage: toNumber(weekly?.percentage),
                resetAt: formatReset(weekly?.nextResetTime),
            },
        };
    } catch (error) {
        return { status: "error", note: (error as Error).message };
    }
}

function stripAnsi(value: string): string {
    return value.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1B[@-_]/g, "");
}

function cleanPanelText(value: string | null | undefined): string | null {
    if (!value) {
        return null;
    }

    const cleaned = value.replace(/[│╭╮╰╯]/g, "").trim();
    return cleaned || null;
}

async function checkOpenAi(): Promise<QuotasResponse["openai"]> {
    try {
        const codexPath = process.env.CODEX_BIN || "/home/ubuntu/.npm-global/bin/codex";

        const command = `bash -lc '
set -e
SESSION="codex_quota_$$_$(date +%s)"
cleanup() {
  tmux has-session -t "$SESSION" 2>/dev/null && tmux kill-session -t "$SESSION" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if ! command -v tmux >/dev/null 2>&1; then
  echo "__ERR__:tmux_not_found"
  exit 0
fi

if [ ! -x "${codexPath}" ]; then
  echo "__ERR__:codex_not_found"
  exit 0
fi

tmux new-session -d -s "$SESSION" -c /home/ubuntu/.openclaw "${codexPath}"

READY=""
for i in $(seq 1 20); do
  SNAP=$(tmux capture-pane -pt "$SESSION" -S -120 || true)
  if echo "$SNAP" | grep -Eiq "OpenAI Codex|Tip:|model:"; then
    READY="1"
    break
  fi
  sleep 1
done

if [ -z "$READY" ]; then
  echo "__ERR__:codex_not_ready"
  tmux capture-pane -pt "$SESSION" -S -200 || true
  exit 0
fi

tmux send-keys -t "$SESSION" C-u
sleep 0.2
tmux send-keys -t "$SESSION" "/status" Enter
sleep 0.4
tmux send-keys -t "$SESSION" Enter

OUT=""
for i in $(seq 1 20); do
  OUT=$(tmux capture-pane -pt "$SESSION" -S -320 || true)
  if echo "$OUT" | grep -Eiq "5h limit:|Weekly limit:"; then
    break
  fi
  sleep 1
done

printf "%s\\n" "$OUT"
'`;

        const rawOutput = execSync(command, {
            stdio: ["ignore", "pipe", "pipe"],
            encoding: "utf8",
            timeout: 45000,
        });

        const output = stripAnsi(rawOutput).replace(/\r/g, "");

        if (output.includes("__ERR__:tmux_not_found")) {
            return { status: "error", note: "tmux not found" };
        }

        if (output.includes("__ERR__:codex_not_found")) {
            return { status: "not_configured", note: "codex binary not found" };
        }

        if (output.includes("__ERR__:codex_not_ready")) {
            return { status: "error", note: "Codex CLI did not become ready in time" };
        }

        const lines = output
            .split("\n")
            .map((line) => line.replace(/[│╭╮╰╯]/g, "").trim())
            .filter(Boolean);

        function parseLimit(prefix: string): { leftPercent: number; resetAt: string | null } | null {
            const index = lines.findIndex((line) => line.toLowerCase().includes(prefix.toLowerCase()));
            if (index < 0) {
                return null;
            }

            const currentLine = lines[index];
            const nextLine = lines[index + 1] || "";
            const joined = `${currentLine} ${nextLine}`;

            const leftMatch = joined.match(/(\d+)%\s*left/i);
            if (!leftMatch) {
                return null;
            }

            const resetMatch = joined.match(/\(resets\s*([^\)]+)\)/i);

            return {
                leftPercent: toNumber(leftMatch[1]),
                resetAt: resetMatch?.[1]?.trim() || null,
            };
        }

        const fiveHour = parseLimit("5h limit:");
        const weekly = parseLimit("weekly limit:");
        const accountMatch = output.match(/Account:\s*(.+)/i);
        const modelMatch = output.match(/Model:\s*(.+?)(?:\s*\(|$)/i);

        if (!fiveHour || !weekly) {
            console.error("[OpenAI Quota] Failed to parse /status output", { preview: output.slice(0, 1000) });
            return { status: "error", note: "Could not parse Codex /status output" };
        }

        const fiveHourLeftPercent = fiveHour.leftPercent;
        const weeklyLeftPercent = weekly.leftPercent;
        const percentUsed = Math.max(100 - Math.min(fiveHourLeftPercent, weeklyLeftPercent), 0);

        return {
            account: cleanPanelText(accountMatch?.[1]),
            model: cleanPanelText(modelMatch?.[1]),
            fiveHourLeftPercent,
            weeklyLeftPercent,
            fiveHourReset: fiveHour.resetAt,
            weeklyReset: weekly.resetAt,
            percentUsed,
            resetAt: weekly.resetAt,
        };
    } catch (error) {
        return { status: "error", note: (error as Error).message };
    }
}

export function hasQuotaStatus(value: unknown): value is { status: "not_configured" | "error"; note?: string } {
    return (
        typeof value === "object" &&
        value !== null &&
        "status" in value &&
        (value.status === "not_configured" || value.status === "error")
    );
}

export async function fetchQuotas(): Promise<QuotasResponse> {
    const [openrouter, elevenlabs, zai, openai] = await Promise.all([
        checkOpenRouter(),
        checkElevenLabs(),
        checkZai(),
        checkOpenAi(),
    ]);

    return {
        openrouter,
        elevenlabs,
        zai,
        openai,
        checkedAt: Date.now(),
        cacheAgeMs: 0,
    };
}

export async function refreshQuotasCache(force = false): Promise<QuotasResponse> {
    const now = Date.now();
    if (!force && cache && now - cache.fetchedAt < CACHE_TTL_MS) {
        return cache.value;
    }

    if (!quotasFetchInFlight) {
        quotasFetchInFlight = fetchQuotas()
            .then((payload) => {
                cache = { value: payload, fetchedAt: Date.now() };
                return payload;
            })
            .finally(() => {
                quotasFetchInFlight = null;
            });
    }

    return quotasFetchInFlight;
}

export function startQuotasMonitor(intervalMs = CACHE_TTL_MS): void {
    const safeInterval = Number.isFinite(intervalMs) && intervalMs >= 60_000 ? intervalMs : CACHE_TTL_MS;

    void refreshQuotasCache(true).catch((error) => {
        console.error("[Quotas] initial refresh failed", error);
    });

    setInterval(() => {
        void refreshQuotasCache(true).catch((error) => {
            console.error("[Quotas] scheduled refresh failed", error);
        });
    }, safeInterval).unref();
}

export default function quotasRoutes(app: express.Application): void {
    app.get("/api/quotas", (async (_req, res) => {
        try {
            const payload = await refreshQuotasCache();
            const now = Date.now();
            res.json({ ...payload, cacheAgeMs: now - payload.checkedAt } satisfies QuotasResponse);
        } catch (error) {
            if (cache) {
                const now = Date.now();
                res.json({
                    ...cache.value,
                    cacheAgeMs: now - cache.fetchedAt,
                } satisfies QuotasResponse);
                return;
            }

            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);
}
