import { useLiveQuery } from "@tanstack/react-db";
import { WifiOff } from "lucide-react";
import { useState } from "react";

import { sessionsCollection } from "../collections/sessions";
import { SESSION_TYPES, SessionsTable } from "../components/features/sessions";
import { Alert } from "../components/ui/Alert";
import { ConfirmModal } from "../components/ui/ConfirmModal";
import { FilterButtonGroup } from "../components/ui/FilterButtonGroup";
import { useOpenClawSocket } from "../hooks/useOpenClawSocket";
import { useSessionActions } from "../hooks/useSessionActions";
import { type Session } from "../types/session";
import { sortSessionsByTypeAndActivity } from "../utils/sessionUtils";

/** Renders the sessions UI. */
export function Sessions() {
    const { isConnected, error } = useOpenClawSocket();
    const sessionActions = useSessionActions();
    const [deleteTarget, setDeleteTarget] = useState<Session | null>(null);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const [typeFilter, setTypeFilter] = useState<string>("ALL");

    const { data: sessions = [] } = useLiveQuery((q) =>
        q.from({ session: sessionsCollection })
    );

    const sessionRows = Array.isArray(sessions) ? sessions : [];
    const sortedSessions = sortSessionsByTypeAndActivity(sessionRows);
    const filteredSessions =
        typeFilter === "ALL"
            ? sortedSessions
            : sortedSessions.filter((s) => (s.type || "").toUpperCase() === typeFilter);

    /** Deletes the selected session after confirmation and reports failures inline. */
    const handleDeleteConfirm = async () => {
        if (!deleteTarget || !deleteTarget.key || sessionActions.isDeleting) return;

        const target = deleteTarget;
        setDeleteError(null);
        setDeleteTarget(null);

        try {
            await sessionActions.remove(target.key);
        } catch (error_) {
            console.error("Failed to delete session:", error_);
            setDeleteError(
                error_ instanceof Error ? error_.message : "Failed to delete session"
            );
        }
    };

    const filterOptions = SESSION_TYPES.map((type) => ({ value: type, label: type }));

    return (
        <div className="p-3 sm:p-4 lg:p-6">
            <div className="mb-4 overflow-x-auto pb-1">
                <FilterButtonGroup
                    options={filterOptions}
                    value={typeFilter}
                    onChange={setTypeFilter}
                />
            </div>

            {error && <Alert variant="error">{error}</Alert>}
            {deleteError && <Alert variant="error">{deleteError}</Alert>}

            {!isConnected && !error && (
                <div className="py-8 text-center">
                    <WifiOff className="text-primary-400 mx-auto mb-4 h-12 w-12" />
                    <p className="text-primary-300">Connecting to OpenClaw...</p>
                </div>
            )}

            {isConnected && (
                <SessionsTable
                    sessions={filteredSessions}
                    onCompact={(sessionKey: string) => sessionActions.compact(sessionKey)}
                    onReset={(sessionKey: string) => sessionActions.reset(sessionKey)}
                    onDelete={setDeleteTarget}
                />
            )}

            <ConfirmModal
                isOpen={!!deleteTarget}
                title="Delete session"
                message={
                    deleteTarget
                        ? `Are you sure you want to delete ${deleteTarget.displayLabel || deleteTarget.key}?`
                        : "Are you sure you want to delete this session?"
                }
                confirmLabel="Delete"
                confirmLoadingLabel="Deleting..."
                loading={sessionActions.isDeleting}
                danger
                onCancel={() => setDeleteTarget(null)}
                onConfirm={() => {
                    void handleDeleteConfirm();
                }}
            />
        </div>
    );
}
