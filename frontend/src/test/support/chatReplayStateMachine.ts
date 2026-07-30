import {
    type ChatRuntimeEvent,
    type ChatRuntimeState,
    createChatRuntimeState,
    reduceChatRuntime,
} from "../../components/features/chat/domain/chatState";

export type ChatReplayMachineStepKind =
    | "duplicate-replay"
    | "live"
    | "reconnect"
    | "snapshot";

export interface ChatReplayMachineStep {
    kind: ChatReplayMachineStepKind;
    sequences: number[];
}

export interface ChatReplayMachineResult {
    checkpoints: ChatRuntimeState[];
    state: ChatRuntimeState;
    steps: ChatReplayMachineStep[];
}

type RandomSource = () => number;

function seededRandom(seed = 1_831_565_813): RandomSource {
    let state = seed;
    return () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        const unsignedState = state < 0 ? state + 4_294_967_296 : state;
        return unsignedState / 4_294_967_296;
    };
}

function randomInteger(random: RandomSource, minimum: number, maximum: number): number {
    return minimum + Math.floor(random() * (maximum - minimum));
}

function shuffled<T>(values: T[], random: RandomSource): T[] {
    const next = [...values];
    for (let index = next.length - 1; index > 0; index -= 1) {
        const other = randomInteger(random, 0, index + 1);
        [next[index], next[other]] = [next[other]!, next[index]!];
    }
    return next;
}

function faultedBatch(
    events: ChatRuntimeEvent[],
    random: RandomSource
): ChatRuntimeEvent[] {
    if (events.length === 0) {
        return [];
    }
    const duplicateCount = Math.min(events.length, 1 + randomInteger(random, 0, 3));
    const duplicated = [...events];
    for (let index = 0; index < duplicateCount; index += 1) {
        duplicated.push(events[randomInteger(random, 0, events.length)]!);
    }
    return shuffled(duplicated, random);
}

function applyBatch(
    state: ChatRuntimeState,
    events: ChatRuntimeEvent[],
    kind: ChatReplayMachineStepKind,
    random: RandomSource,
    steps: ChatReplayMachineStep[]
): ChatRuntimeState {
    const batch = faultedBatch(events, random);
    steps.push({ kind, sequences: batch.map((event) => event.sequence) });
    return reduceChatRuntime(state, batch);
}

function applyLiveRange(
    state: ChatRuntimeState,
    events: ChatRuntimeEvent[],
    start: number,
    end: number,
    random: RandomSource,
    steps: ChatReplayMachineStep[]
): ChatRuntimeState {
    let next = state;
    let cursor = start;
    while (cursor < end) {
        const size = randomInteger(random, 1, Math.min(4, end - cursor) + 1);
        const rangeEnd = Math.min(end, cursor + size);
        const batch = events.slice(cursor, rangeEnd);
        if (cursor > 0) {
            batch.push(events[randomInteger(random, 0, cursor)]!);
        }
        next = applyBatch(next, batch, "live", random, steps);
        cursor = rangeEnd;
    }
    return next;
}

/**
 * Replays one canonical event stream through duplicate, reorder, reconnect, and
 * partial-snapshot transitions while preserving sequence-contiguous live ranges.
 * @param events Canonical source events in causal sequence order.
 * @param seed Deterministic fault-generation seed.
 * @returns Final state, transition trace, and intermediate state checkpoints.
 */
export function runChatReplayStateMachine(
    events: ChatRuntimeEvent[],
    seed: number
): ChatReplayMachineResult {
    if (events.length < 6) {
        throw new Error("chat replay state machine requires at least six events");
    }
    const random = seededRandom(seed);
    const steps: ChatReplayMachineStep[] = [];
    const checkpoints: ChatRuntimeState[] = [];
    const firstMinimum = Math.max(1, Math.floor(events.length / 4));
    const firstMaximum = Math.max(firstMinimum + 1, Math.floor(events.length / 2));
    const firstBoundary = randomInteger(random, firstMinimum, firstMaximum);
    const secondMinimum = Math.max(
        firstBoundary + 1,
        Math.floor((events.length * 2) / 3)
    );
    const secondBoundary = randomInteger(random, secondMinimum, events.length);

    let state = applyBatch(
        createChatRuntimeState(),
        events.slice(0, firstBoundary),
        "snapshot",
        random,
        steps
    );
    checkpoints.push(state);
    state = applyBatch(
        state,
        events.slice(0, firstBoundary),
        "duplicate-replay",
        random,
        steps
    );
    checkpoints.push(state);

    state = applyBatch(
        createChatRuntimeState(1),
        events.slice(0, firstBoundary),
        "reconnect",
        random,
        steps
    );
    state = applyLiveRange(state, events, firstBoundary, secondBoundary, random, steps);
    checkpoints.push(state);

    state = applyBatch(
        createChatRuntimeState(2),
        events.slice(0, secondBoundary),
        "reconnect",
        random,
        steps
    );
    state = applyLiveRange(state, events, secondBoundary, events.length, random, steps);
    checkpoints.push(state);

    return { checkpoints, state, steps };
}
