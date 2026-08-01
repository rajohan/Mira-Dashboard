import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runProcess } from "../../lib/processes.ts";
import { nonEmptyEnvironmentFallback } from "../../lib/values.ts";
import { writeCacheSuccess } from "../cacheEntryWriter.ts";
import { evaluateQuotaNotifications } from "../quotaNotifications.ts";
import {
    asRecord,
    dateToISOString,
    errorMessage,
    fetchJson,
    stripAnsi,
    type JsonRecord,
    toCurrencyNumber,
    toNumber,
    toOptionalNumber,
    toOptionalString,
} from "./cacheProducerSupport.ts";

async function checkOpenRouterQuota() {
    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) return { status: "not_configured" as const };
    const [keyInfo, creditsInfo] = await Promise.all([
        fetchJson("https://openrouter.ai/api/v1/key", {
            Authorization: `Bearer ${apiKey}`,
        }) as Promise<JsonRecord>,
        fetchJson("https://openrouter.ai/api/v1/credits", {
            Authorization: `Bearer ${apiKey}`,
        }) as Promise<JsonRecord>,
    ]);
    const keyData = asRecord(keyInfo.data);
    const usage = toNumber(keyData.usage);
    const totalCredits = toNumber(asRecord(creditsInfo.data).total_credits);
    const limit = toOptionalNumber(keyData.limit);
    const limitRemaining = toOptionalNumber(keyData.limit_remaining);
    let percentUsed =
        totalCredits > 0 ? Math.round((usage / totalCredits) * 100) : undefined;
    if (limit !== undefined && limitRemaining !== undefined && limit > 0) {
        percentUsed = Number((((limit - limitRemaining) / limit) * 100).toFixed(1));
    }
    return {
        usage,
        totalCredits,
        remaining: Math.max(totalCredits - usage, 0),
        limit,
        limitRemaining,
        limitReset:
            typeof keyData.limit_reset === "string" ? keyData.limit_reset : undefined,
        usageMonthly: toNumber(keyData.usage_monthly),
        percentUsed,
    };
}

async function checkElevenLabsQuota() {
    const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
    if (!apiKey) return { status: "not_configured" as const };
    const data = asRecord(
        await fetchJson("https://api.elevenlabs.io/v1/user", {
            "xi-api-key": apiKey,
        })
    );
    const subscription = asRecord(data.subscription);
    const used = toNumber(subscription.character_count);
    const total = toNumber(subscription.character_limit);
    const resetMsCandidate = toOptionalNumber(
        subscription.next_character_count_reset_unix_ms
    );
    const resetSecCandidate = toOptionalNumber(
        subscription.next_character_count_reset_unix
    );
    let resetAt: string | undefined;
    if (resetSecCandidate !== undefined && resetSecCandidate > 0) {
        resetAt = dateToISOString(new Date(resetSecCandidate * 1000));
    }
    if (resetMsCandidate !== undefined && resetMsCandidate > 0) {
        resetAt = dateToISOString(new Date(resetMsCandidate));
    }
    return {
        used,
        total,
        remaining: Math.max(total - used, 0),
        tier: toOptionalString(subscription.tier) || "unknown",
        percentUsed: total > 0 ? Math.round((used / total) * 100) : undefined,
        resetAt,
    };
}

async function checkSyntheticQuota() {
    const apiKey = process.env.SYNTHETIC_API_KEY?.trim();
    if (!apiKey) return { status: "not_configured" as const };
    const data = asRecord(
        await fetchJson("https://api.synthetic.new/v2/quotas", {
            Authorization: `Bearer ${apiKey}`,
        })
    );
    const subscription = asRecord(data.subscription);
    const search = asRecord(data.search);
    const searchHourly = asRecord(search.hourly);
    const weeklyTokenLimit = asRecord(data.weeklyTokenLimit);
    const rollingFiveHourLimit = asRecord(data.rollingFiveHourLimit);
    const subscriptionLimit = toNumber(subscription.limit);
    const subscriptionRequests = toNumber(subscription.requests);
    const searchHourlyLimit = toNumber(searchHourly.limit);
    const searchHourlyRequests = toNumber(searchHourly.requests);
    const rollingFiveHourMax = toNumber(rollingFiveHourLimit.max);
    const rollingFiveHourRemaining = toNumber(rollingFiveHourLimit.remaining);
    const weeklyMaxCredits = toCurrencyNumber(weeklyTokenLimit.maxCredits);
    const weeklyRemainingCredits = toCurrencyNumber(weeklyTokenLimit.remainingCredits);
    const weeklyNextRegenCredits = toCurrencyNumber(weeklyTokenLimit.nextRegenCredits);
    const explicitWeeklyPercentRemaining = toOptionalNumber(
        weeklyTokenLimit.percentRemaining
    );
    const computedWeeklyPercentRemaining =
        weeklyMaxCredits && weeklyRemainingCredits !== undefined
            ? (weeklyRemainingCredits / weeklyMaxCredits) * 100
            : undefined;
    const weeklyPercentRemaining =
        explicitWeeklyPercentRemaining ?? computedWeeklyPercentRemaining;
    if (weeklyPercentRemaining === undefined) {
        return {
            status: "error" as const,
            note: "Synthetic weekly token percentage missing",
        };
    }
    return {
        subscription: {
            limit: subscriptionLimit,
            requests: subscriptionRequests,
            remaining: Math.max(subscriptionLimit - subscriptionRequests, 0),
            renewsAt: toOptionalString(subscription.renewsAt),
            percentUsed:
                subscriptionLimit > 0
                    ? Math.round((subscriptionRequests / subscriptionLimit) * 100)
                    : undefined,
        },
        searchHourly: {
            limit: searchHourlyLimit,
            requests: searchHourlyRequests,
            remaining: Math.max(searchHourlyLimit - searchHourlyRequests, 0),
            renewsAt: toOptionalString(searchHourly.renewsAt),
            percentUsed:
                searchHourlyLimit > 0
                    ? Math.round((searchHourlyRequests / searchHourlyLimit) * 100)
                    : undefined,
        },
        weeklyTokenLimit: {
            percentRemaining: weeklyPercentRemaining,
            nextRegenAt: toOptionalString(weeklyTokenLimit.nextRegenAt),
            maxCredits: toOptionalString(weeklyTokenLimit.maxCredits),
            remainingCredits: toOptionalString(weeklyTokenLimit.remainingCredits),
            nextRegenCredits: toOptionalString(weeklyTokenLimit.nextRegenCredits),
            nextRegenPercent:
                weeklyMaxCredits && weeklyNextRegenCredits !== undefined
                    ? (weeklyNextRegenCredits / weeklyMaxCredits) * 100
                    : undefined,
        },
        rollingFiveHourLimit: {
            remaining: rollingFiveHourRemaining,
            max: rollingFiveHourMax,
            limited: Boolean(rollingFiveHourLimit.limited),
            nextTickAt: toOptionalString(rollingFiveHourLimit.nextTickAt),
            tickPercent: toNumber(rollingFiveHourLimit.tickPercent, 0),
            percentUsed:
                rollingFiveHourMax > 0
                    ? Math.round(
                          ((rollingFiveHourMax - rollingFiveHourRemaining) /
                              rollingFiveHourMax) *
                              100
                      )
                    : undefined,
        },
    };
}

function getQuotaCodexHome() {
    return nonEmptyEnvironmentFallback("QUOTAS_CODEX_HOME", "/home/ubuntu/.codex");
}

function getCodexBin() {
    return nonEmptyEnvironmentFallback("CODEX_BIN", "/home/ubuntu/.npm-global/bin/codex");
}

async function createCodexQuotaProbe(sourceCodexHome: string): Promise<{
    cleanup: () => Promise<void>;
    codexHome: string;
    workspace: string;
}> {
    const root = await mkdtemp(path.join(os.tmpdir(), "mira-codex-quota-"));
    const codexHome = path.join(root, "codex-home");
    const workspace = path.join(root, "workspace");
    try {
        await Promise.all([
            mkdir(codexHome, { mode: 0o700 }),
            mkdir(workspace, { mode: 0o700 }),
        ]);
        try {
            const authPath = path.join(codexHome, "auth.json");
            await copyFile(path.join(sourceCodexHome, "auth.json"), authPath);
            await chmod(authPath, 0o600);
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
                throw error;
            }
        }
        await writeFile(
            path.join(codexHome, "config.toml"),
            `[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`,
            { mode: 0o600 }
        );
        return {
            cleanup: () => rm(root, { force: true, recursive: true }),
            codexHome,
            workspace,
        };
    } catch (error) {
        await rm(root, { force: true, recursive: true });
        throw error;
    }
}

function cleanPanelText(value: string | undefined) {
    if (!value) return;
    return value.replaceAll(/[│╭╮╰╯]/gu, "").trim() || undefined;
}

function parseOpenAiQuotaOutput(output: string) {
    if (output.includes("__ERR__:tmux_not_found")) {
        return { status: "error" as const, note: "tmux not found" };
    }
    if (output.includes("__ERR__:codex_not_found")) {
        return {
            status: "not_configured" as const,
            note: "codex binary not found",
        };
    }
    function parseLimit(prefix: string) {
        const lines = output
            .split("\n")
            .map((line) => line.replaceAll(/[│╭╮╰╯]/gu, "").trim())
            .filter(Boolean);
        const index = lines.findIndex((line) =>
            line.toLowerCase().includes(prefix.toLowerCase())
        );
        if (index === -1) return;
        const followingLines = lines.slice(index + 1, index + 3);
        const nextLimitIndex = followingLines.findIndex((line) =>
            /\blimit:/iu.test(line)
        );
        const joined = [
            lines[index],
            ...(nextLimitIndex === -1
                ? followingLines
                : followingLines.slice(0, nextLimitIndex)),
        ].join(" ");
        const leftMatch = joined.match(/(\d+)%\s*left/iu);
        if (!leftMatch) return;
        const resetMatch = joined.match(/\(resets\s*([^)]+)\)/iu);
        return {
            leftPercent: toNumber(leftMatch[1]),
            resetAt: resetMatch?.[1]?.trim() || undefined,
        };
    }
    const hasFiveHourLimit = /5h limit:/iu.test(output);
    const fiveHour = parseLimit("5h limit:");
    const weekly = parseLimit("weekly limit:");
    if (!weekly || (hasFiveHourLimit && !fiveHour)) {
        return {
            status: "error" as const,
            note: "Could not parse Codex /status output",
        };
    }
    return {
        account: cleanPanelText(output.match(/Account:\s*(.+)/iu)?.[1]),
        model: cleanPanelText(output.match(/Model:\s*(.+?)(?:\s*\(|$)/iu)?.[1]),
        fiveHourLeftPercent: fiveHour?.leftPercent,
        weeklyLeftPercent: weekly.leftPercent,
        fiveHourReset: fiveHour?.resetAt,
        weeklyReset: weekly.resetAt,
        percentUsed: Math.max(
            100 - Math.min(fiveHour?.leftPercent ?? 100, weekly.leftPercent),
            0
        ),
        resetAt: weekly.resetAt,
    };
}

async function checkOpenAiQuota() {
    try {
        const codexPath = getCodexBin();
        const probe = await createCodexQuotaProbe(getQuotaCodexHome());
        const command = String.raw`set -e
SESSION="$MIRA_QUOTA_CODEX_SESSION"
cleanup(){ tmux has-session -t "$SESSION" 2>/dev/null && tmux kill-session -t "$SESSION" >/dev/null 2>&1 || true; }
trap cleanup EXIT
command -v tmux >/dev/null 2>&1 || { echo "__ERR__:tmux_not_found"; exit 0; }
if [[ "$MIRA_QUOTA_CODEX_BIN" == */* ]]; then
  [ -x "$MIRA_QUOTA_CODEX_BIN" ] || { echo "__ERR__:codex_not_found"; exit 0; }
else
  command -v "$MIRA_QUOTA_CODEX_BIN" >/dev/null 2>&1 || {
    echo "__ERR__:codex_not_found"
    exit 0
  }
fi
tmux new-session -d -s "$SESSION" -c "$MIRA_QUOTA_CODEX_WORKSPACE" env CODEX_HOME="$MIRA_QUOTA_CODEX_HOME" CODEX_DISABLE_UPDATE_CHECK=1 NO_UPDATE_NOTIFIER=1 "$MIRA_QUOTA_CODEX_BIN" --cd "$MIRA_QUOTA_CODEX_WORKSPACE" --no-alt-screen
	OUT=""
	has_limits(){ echo "$OUT" | grep -Eiq "Weekly limit:"; }
	for i in $(seq 1 12); do
	  tmux send-keys -t "$SESSION" C-u
	  tmux send-keys -t "$SESSION" "/status" Enter
	  sleep 0.5
	  OUT=$(tmux capture-pane -pt "$SESSION" -S -320 || true)
	  has_limits && break
	done
	for i in $(seq 1 20); do OUT=$(tmux capture-pane -pt "$SESSION" -S -320 || true); has_limits && break; sleep 1; done
	printf "%s\n" "$OUT"
	`;
        try {
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const sessionName = `codex_quota_${process.pid}_${Date.now()}_${attempt}`;
                try {
                    const { code, stderr, stdout } = await runProcess(
                        "bash",
                        ["-c", command],
                        {
                            env: {
                                PATH: process.env.PATH,
                                NODE_ENV: process.env.NODE_ENV,
                                MIRA_QUOTA_CODEX_BIN: codexPath,
                                MIRA_QUOTA_CODEX_HOME: probe.codexHome,
                                MIRA_QUOTA_CODEX_SESSION: sessionName,
                                MIRA_QUOTA_CODEX_WORKSPACE: probe.workspace,
                            },
                            timeoutMs: 120_000,
                            maxBuffer: 1024 * 1024,
                        }
                    );
                    if (code !== 0) {
                        const output = stripAnsi(`${stderr}\n${stdout}`)
                            .replaceAll("\r", "")
                            .replaceAll(/^.*Account:.*$/gimu, "")
                            .trim()
                            .slice(-1000);
                        return {
                            status: "error" as const,
                            note: `codex quota exited ${code}${output ? `: ${output}` : ""}`,
                        };
                    }
                    const parsed = parseOpenAiQuotaOutput(
                        stripAnsi(stdout).replaceAll("\r", "")
                    );
                    if (attempt === 1 || parsed.status !== "error") {
                        return parsed;
                    }
                } finally {
                    try {
                        await runProcess("tmux", ["kill-session", "-t", sessionName], {
                            env: { PATH: process.env.PATH },
                            timeoutMs: 10_000,
                        });
                    } catch {
                        // Shell cleanup handles normal exits; this covers timeouts.
                    }
                }
            }
            return {
                status: "error" as const,
                note: "Could not parse Codex /status output",
            };
        } finally {
            await probe.cleanup();
        }
    } catch (error) {
        return { status: "error" as const, note: errorMessage(error) };
    }
}

function buildQuotaMissingProviders(
    openrouter: Record<string, unknown>,
    elevenlabs: Record<string, unknown>,
    synthetic: Record<string, unknown>,
    openai: Record<string, unknown>
) {
    return [
        openrouter.status === "not_configured" ? "openrouter" : undefined,
        elevenlabs.status === "not_configured" ? "elevenlabs" : undefined,
        synthetic.status === "not_configured" ? "synthetic" : undefined,
        openai.status === "not_configured" ? "openai" : undefined,
    ].filter(Boolean);
}

async function checkQuotaWithErrorStatus<T>(
    checkQuota: () => Promise<T>
): Promise<T | { status: "error"; note: string }> {
    try {
        return await checkQuota();
    } catch (error) {
        return {
            status: "error",
            note: errorMessage(error),
        };
    }
}

export async function refreshQuotasCache() {
    const checkedAt = Date.now();
    const [openrouter, elevenlabs, synthetic, openai] = await Promise.all([
        checkQuotaWithErrorStatus(checkOpenRouterQuota),
        checkQuotaWithErrorStatus(checkElevenLabsQuota),
        checkQuotaWithErrorStatus(checkSyntheticQuota),
        checkOpenAiQuota(),
    ]);
    const payload = {
        openrouter,
        elevenlabs,
        synthetic,
        openai: redactOpenAiQuotaAccount(openai),
        checkedAt,
        cacheAgeMs: 0,
    };
    writeCacheSuccess({
        key: "quotas.summary",
        data: payload,
        source: "backend",
        ttl: 1,
        ttlUnit: "hours",
        metadata: {
            workflow: "Cache Foundation - Quotas Summary",
            producers: ["openrouter", "elevenlabs", "synthetic", "openai"],
            missing: buildQuotaMissingProviders(
                openrouter,
                elevenlabs,
                synthetic,
                openai
            ),
        },
    });
    evaluateQuotaNotifications(payload);
    return { refreshed: ["quotas.summary"] };
}

function redactOpenAiQuotaAccount(openai: Awaited<ReturnType<typeof checkOpenAiQuota>>) {
    if (!openai || typeof openai !== "object" || !("account" in openai)) {
        return openai;
    }
    const { account, ...redacted } = openai;
    void account;
    return { ...redacted, account: undefined };
}
