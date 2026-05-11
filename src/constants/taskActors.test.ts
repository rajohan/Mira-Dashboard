import { describe, expect, it } from "vitest";

import { TASK_ASSIGNEE_IDS, TASK_ASSIGNEES } from "./taskActors";

describe("task actor constants", () => {
    it("defines dashboard task assignees for Mira and Raymond", () => {
        expect(TASK_ASSIGNEES).toEqual({
            mira: {
                id: "mira-2026",
                label: "Mira",
                githubUrl: "https://github.com/mira-2026",
            },
            raymond: {
                id: "rajohan",
                label: "Raymond",
                githubUrl: "https://github.com/rajohan",
            },
        });
    });

    it("keeps the assignee id list aligned with the canonical objects", () => {
        expect(TASK_ASSIGNEE_IDS).toEqual([
            TASK_ASSIGNEES.mira.id,
            TASK_ASSIGNEES.raymond.id,
        ]);
    });
});
