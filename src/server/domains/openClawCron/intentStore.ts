export type OpenClawCronIntentCreator = Readonly<{
    id: string;
    kind: "automation" | "user";
}>;

export type OpenClawCronIntentClosureActor =
    | OpenClawCronIntentCreator
    | Readonly<{ id: string; kind: "system" }>;

/** One currently open append-only intent for an external OpenClaw cron target. */
export interface OpenClawCronActiveDisableIntent {
    readonly createdBy: OpenClawCronIntentCreator;
    readonly expiresAtMs?: number;
    readonly externalJobId: string;
    readonly reason: string;
    readonly recordedAtMs: number;
    /** Stable persisted row identity used as the optimistic closure fence. */
    readonly revision: string;
}

/** Hard bound for one persisted expiry-reconciliation scan. */
export const openClawCronExpiredIntentBatchMaximum = 100;

/** Minimal persisted identity needed to reconcile one elapsed disable intent. */
export interface OpenClawCronExpiredDisableIntentTarget {
    readonly expiresAtMs: number;
    readonly externalJobId: string;
    readonly revision: string;
}

export interface ReplaceOpenClawCronDisableIntentInput {
    readonly actor: OpenClawCronIntentCreator;
    readonly expiresAtMs?: number;
    readonly externalJobId: string;
    readonly reason: string;
    readonly recordedAtMs: number;
}

export type CloseOpenClawCronDisableIntentInput =
    | Readonly<{
          actor: Readonly<{ id: string; kind: "system" }>;
          atMs: number;
          expectedRevision: string;
          externalJobId: string;
          reason: "expired";
      }>
    | Readonly<{
          actor: OpenClawCronIntentCreator;
          atMs: number;
          expectedRevision: string;
          externalJobId: string;
          reason: "re-enabled";
      }>
    | Readonly<{
          actor: OpenClawCronIntentCreator;
          atMs: number;
          externalJobId: string;
          reason: "target-deleted";
      }>;

/**
 * Append-only persistence seam implemented in production by `job_disable_intents`.
 * Replacements atomically close the previous row and insert one new open row.
 */
export interface OpenClawCronIntentStore {
    closeActive(input: CloseOpenClawCronDisableIntentInput): Promise<boolean>;
    getActive(
        externalJobId: string
    ): Promise<OpenClawCronActiveDisableIntent | undefined>;
    listExpired(
        atMs: number,
        limit: number
    ): Promise<readonly OpenClawCronExpiredDisableIntentTarget[]>;
    replaceActive(
        input: ReplaceOpenClawCronDisableIntentInput
    ): Promise<OpenClawCronActiveDisableIntent>;
}

export interface InMemoryOpenClawCronDisableIntentRecord extends OpenClawCronActiveDisableIntent {
    readonly closedAtMs?: number;
    readonly closedBy?: OpenClawCronIntentClosureActor;
    readonly closedReason?: "expired" | "re-enabled" | "replaced" | "target-deleted";
}

export interface InMemoryOpenClawCronIntentStore extends OpenClawCronIntentStore {
    history(externalJobId: string): readonly InMemoryOpenClawCronDisableIntentRecord[];
}

/**
 * Deterministic append-only test adapter with the same active-row uniqueness semantics as SQLite.
 * @returns A process-local append-only desired-state store.
 */
export function createInMemoryOpenClawCronIntentStore(): InMemoryOpenClawCronIntentStore {
    const historyByExternalId = new Map<
        string,
        InMemoryOpenClawCronDisableIntentRecord[]
    >();
    const activeByExternalId = new Map<string, InMemoryOpenClawCronDisableIntentRecord>();
    let revision = 0;

    function closeCurrent(
        externalJobId: string,
        atMs: number,
        actor: OpenClawCronIntentClosureActor,
        reason: InMemoryOpenClawCronDisableIntentRecord["closedReason"],
        expectedRevision?: string
    ): boolean {
        const current = activeByExternalId.get(externalJobId);
        if (
            current === undefined ||
            (expectedRevision !== undefined && current.revision !== expectedRevision)
        ) {
            return false;
        }
        if (
            reason === "expired" &&
            (current.expiresAtMs === undefined || atMs < current.expiresAtMs)
        ) {
            throw new RangeError("OpenClaw cron intent cannot close before expiry");
        }
        const closed = Object.freeze({
            ...current,
            closedAtMs: Math.max(atMs, current.recordedAtMs),
            closedBy: actor,
            closedReason: reason,
        });
        const history = historyByExternalId.get(externalJobId) ?? [];
        const index = history.findIndex(({ revision: id }) => id === current.revision);
        if (index === -1) {
            throw new Error("Active OpenClaw cron intent is not in history");
        }
        history[index] = closed;
        activeByExternalId.delete(externalJobId);
        return true;
    }

    return {
        closeActive(input) {
            const expectedRevision =
                "expectedRevision" in input ? input.expectedRevision : undefined;
            return Promise.resolve(
                closeCurrent(
                    input.externalJobId,
                    input.atMs,
                    input.actor,
                    input.reason,
                    expectedRevision
                )
            );
        },
        getActive(externalJobId) {
            return Promise.resolve(activeByExternalId.get(externalJobId));
        },
        history(externalJobId) {
            return Object.freeze([...(historyByExternalId.get(externalJobId) ?? [])]);
        },
        listExpired(atMs, limit) {
            if (
                !Number.isSafeInteger(atMs) ||
                atMs < 0 ||
                !Number.isSafeInteger(limit) ||
                limit < 1 ||
                limit > openClawCronExpiredIntentBatchMaximum
            ) {
                return Promise.reject(
                    new RangeError("OpenClaw cron expiry scan is outside its budget")
                );
            }
            return Promise.resolve(
                [...activeByExternalId.values()]
                    .filter(
                        (
                            intent
                        ): intent is InMemoryOpenClawCronDisableIntentRecord & {
                            readonly expiresAtMs: number;
                        } =>
                            intent.expiresAtMs !== undefined && intent.expiresAtMs <= atMs
                    )
                    .toSorted(
                        (left, right) =>
                            left.expiresAtMs - right.expiresAtMs ||
                            left.revision.localeCompare(right.revision)
                    )
                    .slice(0, limit)
                    .map(({ expiresAtMs, externalJobId, revision }) =>
                        Object.freeze({ expiresAtMs, externalJobId, revision })
                    )
            );
        },
        replaceActive(input) {
            closeCurrent(
                input.externalJobId,
                input.recordedAtMs,
                input.actor,
                "replaced"
            );
            revision += 1;
            const stored = Object.freeze({
                createdBy: input.actor,
                ...(input.expiresAtMs === undefined
                    ? {}
                    : { expiresAtMs: input.expiresAtMs }),
                externalJobId: input.externalJobId,
                reason: input.reason,
                recordedAtMs: input.recordedAtMs,
                revision: `memory:${revision}`,
            });
            const history = historyByExternalId.get(input.externalJobId) ?? [];
            history.push(stored);
            historyByExternalId.set(input.externalJobId, history);
            activeByExternalId.set(input.externalJobId, stored);
            return Promise.resolve(stored);
        },
    };
}
