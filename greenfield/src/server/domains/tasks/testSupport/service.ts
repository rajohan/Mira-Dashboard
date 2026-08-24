import { Effect } from "effect";

import { TaskService } from "../service.ts";

function unexpectedTaskServiceCall(): Effect.Effect<never> {
    return Effect.die(new Error("Test task service received an unexpected call"));
}

/**
 * Creates an inert task service for tests whose subject does not include task behavior.
 * @param overrides Exact task methods exercised by the current test.
 * @returns Complete task service test double.
 */
export function createTestTaskService(
    overrides: Partial<TaskService["Service"]> = {}
): TaskService["Service"] {
    return TaskService.of({
        addTaskProgress: unexpectedTaskServiceCall,
        assignTask: unexpectedTaskServiceCall,
        createTask: unexpectedTaskServiceCall,
        deleteTask: unexpectedTaskServiceCall,
        deleteTaskProgress: unexpectedTaskServiceCall,
        getTask: unexpectedTaskServiceCall,
        listTaskLabels: unexpectedTaskServiceCall,
        listTaskProgress: unexpectedTaskServiceCall,
        listTasks: unexpectedTaskServiceCall,
        moveTask: unexpectedTaskServiceCall,
        updateTask: unexpectedTaskServiceCall,
        updateTaskProgress: unexpectedTaskServiceCall,
        ...overrides,
    });
}
