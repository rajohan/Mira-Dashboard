import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    agentConfigurationSchema,
    agentStatusSchema,
    agentTaskRunSchema,
} from "./agentModel.ts";

const runId = "019fdc00-0000-7000-8000-000000000001";

describe("agent model contracts", () => {
    test("canonicalizes a unique bounded agent directory", () => {
        const configuration = v.parse(agentConfigurationSchema, {
            agents: [
                {
                    description: "Runs bounded specialist work.",
                    displayName: "Researcher",
                    id: "researcher",
                    role: "specialist",
                },
                {
                    description: "Owns the operator conversation.",
                    displayName: "Mira",
                    id: "main",
                    role: "primary",
                },
            ],
        });

        expect(configuration.agents.map(({ id }) => id)).toEqual(["main", "researcher"]);
        expect(Object.isFrozen(configuration.agents)).toBeTrue();
        expect(
            v.safeParse(agentConfigurationSchema, {
                agents: [configuration.agents[0], configuration.agents[0]],
            }).success
        ).toBeFalse();
    });

    test("rejects inconsistent status and task-run timestamps", () => {
        expect(
            v.safeParse(agentStatusSchema, {
                agentId: "main",
                currentTask: "Implement agent status",
                lastActivityAtMs: 999,
                startedAtMs: 1000,
                state: "working",
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(agentTaskRunSchema, {
                agentId: "main",
                completedAtMs: 1001,
                id: runId,
                lastActivityAtMs: 1002,
                startedAtMs: 1000,
                status: "completed",
                task: "Implement agent status",
            }).success
        ).toBeFalse();
    });
});
