import { useLiveQuery } from "@tanstack/react-db";
import { WifiOff } from "lucide-react";
import { useState } from "react";

import { sessionsCollection } from "../collections/sessions";
import {
    DeleteConfirmDialog,
    SESSION_TYPES,
    SessionDetails,
    SessionsTable,
} from "../components/features/sessions";
import { Alert } from "../components/ui/Alert";
import { ConnectionStatus } from "../components/ui/ConnectionStatus";
import { FilterButtonGroup } from "../components/ui/FilterButtonGroup";
import { PageHeader } from "../components/ui/PageHeader";
import { RefreshButton } from "../components/ui/RefreshButton";
import { useOpenClawSocket } from "../hooks/useOpenClawSocket";
import { useDeleteSession, useSessionAction } from "../hooks/useSessions";
import { type Session } from "../types/session";
import { sortSessionsByTypeAndActivity } from "../utils/sessionUtils";

export function Sessions() {
    const { isConnected, error, request } = useOpenClawSocket();
    const sessionAction = useSessionAction();
    const deleteSessionMutation = useDeleteSession();
    const [isLoading, setIsLoading] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<Session | null>(null);
    const [selectedSession, setSelectedSession] = useState<Session | null>(null);
    const [typeFilter, setTypeFilter] = useState<string>("ALL");

    // Sessions from collection using live query
    const { data: sessions = [] } = useLiveQuery((q) =>
        q.from({ session: sessionsCollection })
    );

    const handleRefresh = async () => {
        setIsLoading(true);
        try {
            await request("sessions.list", {});
        } finally {
            setTimeout(() => setIsLoading(false), 300);
        }
    };

    const handleDeleteConfirm = async () => {
        if (!deleteTarget || !deleteTarget.key) return;
        try {
            await deleteSessionMutation.mutateAsync(deleteTarget.key);
            setDeleteTarget(null);
        } catch (error_) {
            console.error("Failed to delete session:", error_);
        }
    };

    const handleStop = (sessionKey: string) => {
        sessionAction.mutate({ key: sessionKey, action: "stop" });
    };

    const handleCompact = (sessionKey: string) => {
        sessionAction.mutate({ key: sessionKey, action: "compact" });
    };

    const handleReset = (sessionKey: string) => {
        sessionAction.mutate({ key: sessionKey, action: "reset" });
    };

    const sortedSessions = sortSessionsByTypeAndActivity(sessions || []);
    const filteredSessions =
        typeFilter === "ALL"
            ? sortedSessions
            : sortedSessions.filter((s) => (s.type || "").toUpperCase() === typeFilter);

    const filterOptions = SESSION_TYPES.map((type) => ({
        value: type,
        label: type,
    }));

    return (
        <div className="p-6">
            <PageHeader
                title="Sessions"
                actions={
                    <RefreshButton
                        onClick={handleRefresh}
                        isLoading={isLoading}
                        disabled={!isConnected}
                    />
                }
                status={<ConnectionStatus isConnected={isConnected} />}
            />

            <div className="mb-4">
                <FilterButtonGroup
                    options={filterOptions}
                    value={typeFilter}
                    onChange={setTypeFilter}
                />
            </div>

            {error && <Alert variant="error">{error}</Alert>}

            {!isConnected && !error && (
                <div className="py-8 text-center">
                    <WifiOff className="mx-auto mb-4 h-12 w-12 text-slate-400" />
                    <p className="text-slate-300">Connecting to OpenClaw...</p>
                </div>
            )}

            {isConnected && (
                <SessionsTable
                    sessions={filteredSessions}
                    onSelectSession={setSelectedSession}
                    onStop={handleStop}
                    onCompact={handleCompact}
                    onReset={handleReset}
                    onDelete={setDeleteTarget}
                />
            )}

            <DeleteConfirmDialog
                session={deleteTarget}
                onConfirm={handleDeleteConfirm}
                onCancel={() => setDeleteTarget(null)}
                isLoading={deleteSessionMutation.isPending}
            />

            <SessionDetails
                session={selectedSession}
                onClose={() => setSelectedSession(null)}
                onDelete={() => {
                    if (selectedSession) {
                        setDeleteTarget(selectedSession);
                        setSelectedSession(null);
                    }
                }}
                onStop={() => {
                    if (selectedSession) {
                        handleStop(selectedSession.key);
                        setSelectedSession(null);
                    }
                }}
                onCompact={() => {
                    if (selectedSession) {
                        handleCompact(selectedSession.key);
                        setSelectedSession(null);
                    }
                }}
                onReset={() => {
                    if (selectedSession) {
                        handleReset(selectedSession.key);
                        setSelectedSession(null);
                    }
                }}
            />
        </div>
    );
}
