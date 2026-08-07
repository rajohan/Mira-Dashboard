import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    agentProcedureContracts,
    agentTaskHistoryPageDefault,
    listAgentTaskHistoryInputSchema,
    listAgentTaskHistoryResultSchema,
    listAgentStatusesResultSchema,
    updateAgentMetadataInputSchema,
} from "./agents.ts";

const firstRunId = "019fdc00-0000-7000-8000-000000000001";
const secondRunId = "019fdc00-0000-7000-8000-000000000002";

describe("agent procedure contracts", () => {
    test("locks read and write capabilities to the intended procedures", () => {
        expect(
            agentProcedureContracts.map(({ access, kind, name }) => ({
                access,
                kind,
                name,
            }))
        ).toEqual([
            {
                access: {
                    capabilities: ["agents:read"],
                    capabilityPolicy: "all",
                    kind: "authenticated",
                },
                kind: "query",
                name: "agents.getConfiguration",
            },
            {
                access: {
                    capabilities: ["agents:read"],
                    capabilityPolicy: "all",
                    kind: "authenticated",
                },
                kind: "query",
                name: "agents.getStatus",
            },
            {
                access: {
                    capabilities: ["agents:read"],
                    capabilityPolicy: "all",
                    kind: "authenticated",
                },
                kind: "query",
                name: "agents.listStatuses",
            },
            {
                access: {
                    capabilities: ["agents:read"],
                    capabilityPolicy: "all",
                    kind: "authenticated",
                },
                kind: "query",
                name: "agents.listTaskHistory",
            },
            {
                access: {
                    capabilities: ["agents:write"],
                    capabilityPolicy: "all",
                    kind: "authenticated",
                    principalKinds: ["automation"],
                },
                kind: "mutation",
                name: "agents.updateMetadata",
            },
        ]);
    });

    test("defaults and bounds newest-first task history", () => {
        expect(v.parse(listAgentTaskHistoryInputSchema, {})).toEqual({
            limit: agentTaskHistoryPageDefault,
        });
        expect(
            v.safeParse(listAgentTaskHistoryResultSchema, {
                runs: [
                    {
                        agentId: "main",
                        id: firstRunId,
                        lastActivityAtMs: 1000,
                        startedAtMs: 1000,
                        status: "active",
                        task: "Newer task",
                    },
                    {
                        agentId: "main",
                        completedAtMs: 2001,
                        id: secondRunId,
                        lastActivityAtMs: 2001,
                        startedAtMs: 2000,
                        status: "completed",
                        task: "Incorrect newer row",
                    },
                ],
            }).success
        ).toBeFalse();
    });

    test("requires canonical unique statuses and explicit task clearing", () => {
        expect(
            v.safeParse(listAgentStatusesResultSchema, {
                statuses: [
                    { agentId: "researcher", state: "idle" },
                    { agentId: "main", state: "idle" },
                ],
            }).success
        ).toBeFalse();
        expect(
            v.parse(updateAgentMetadataInputSchema, {
                agentId: "main",
                currentTask: null,
            })
        ).toEqual({ agentId: "main", currentTask: null });
        expect(
            v.safeParse(updateAgentMetadataInputSchema, { agentId: "main" }).success
        ).toBeFalse();
    });
});
