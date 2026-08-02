import { useLiveQuery } from "@tanstack/react-db";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import type { Session } from "../../../../../contracts/sessions";
import { sessionsCollection } from "../../../collections/sessions";
import { useAgentsStatus } from "../../../hooks/useAgents";
import { useOpenClawSocket } from "../../../hooks/useOpenClawSocket";
import {
    formatSessionType,
    sortSessionsByTypeAndActivity,
} from "../../../utils/sessionUtilities";
import { isSameChatSession } from "./domain/chatState";

function normalizeChatAgentId(agentId: string): string {
    return agentId.toLowerCase();
}

function getChatAgentId(session: Session): string {
    const sessionKey = typeof session.key === "string" ? session.key : "";
    const [scope = "", agentId] = sessionKey.split(":", 2);
    if (agentId && scope.toLowerCase() === "agent") {
        return normalizeChatAgentId(agentId);
    }
    return normalizeChatAgentId(session.agentType || session.type || "unknown");
}

function hasSessionKey(session: Session): boolean {
    return typeof session.key === "string" && session.key.length > 0;
}

function formatChatSessionLabel(session: Session, agentId: string): string {
    const sessionKey = session.key;
    const [scope = "", keyAgentId, ...sessionParts] = sessionKey.split(":");
    if (
        keyAgentId &&
        scope.toLowerCase() === "agent" &&
        normalizeChatAgentId(keyAgentId) === agentId
    ) {
        return sessionParts.join(":") || sessionKey;
    }
    return session.displayLabel || session.label || session.displayName || sessionKey;
}

/**
 * Owns URL-backed chat session and agent selection.
 * @returns Selected session, selector options, and navigation actions.
 */
export function useChatSessionSelection() {
    const navigate = useNavigate();
    const search = useSearch({ strict: false });
    const requestedSessionKey = search.session?.trim() || "";
    const availableSessionKeysRef = useRef<Set<string>>(new Set());
    const { hasConfirmedSessionList } = useOpenClawSocket();
    const { data: sessions } = useLiveQuery((query) =>
        query.from({ session: sessionsCollection })
    );
    const { data: agentsStatus } = useAgentsStatus();
    const agents = agentsStatus?.agents || [];
    const sortedSessions = sortSessionsByTypeAndActivity(sessions ?? []);
    const firstAvailableSessionKey =
        sortedSessions.find((session) => hasSessionKey(session))?.key ?? "";
    const isRequestedSessionAvailable = sortedSessions.some(
        (session) => session.key === requestedSessionKey && hasSessionKey(session)
    );
    const selectedSessionKey = requestedSessionKey || firstAvailableSessionKey;
    const sessionMap = new Map(sortedSessions.map((session) => [session.key, session]));
    const selectedSession = selectedSessionKey
        ? sessionMap.get(selectedSessionKey) || undefined
        : undefined;
    const selectedAgentId = selectedSession ? getChatAgentId(selectedSession) : "";
    const sessionsForSelectedAgent = selectedAgentId
        ? sortedSessions.filter((session) => getChatAgentId(session) === selectedAgentId)
        : sortedSessions;

    const selectSession = (sessionKey: string) => {
        void navigate({
            to: "/chat",
            search: sessionKey ? { session: sessionKey } : {},
            replace: true,
        });
    };

    useEffect(() => {
        const availableSessionKeys = new Set(
            (sessions ?? [])
                .filter((session) => hasSessionKey(session))
                .map((session) => session.key)
        );
        const wasRequestedSessionAvailable = Boolean(
            requestedSessionKey &&
            availableSessionKeysRef.current.has(requestedSessionKey)
        );
        availableSessionKeysRef.current = availableSessionKeys;

        if (!requestedSessionKey) {
            if (firstAvailableSessionKey) {
                void navigate({
                    replace: true,
                    search: { session: firstAvailableSessionKey },
                    to: "/chat",
                });
            }
            return;
        }
        if (
            !hasConfirmedSessionList ||
            isRequestedSessionAvailable ||
            !wasRequestedSessionAvailable
        ) {
            return;
        }
        void navigate({
            replace: true,
            search: firstAvailableSessionKey ? { session: firstAvailableSessionKey } : {},
            to: "/chat",
        });
    }, [
        firstAvailableSessionKey,
        hasConfirmedSessionList,
        isRequestedSessionAvailable,
        navigate,
        requestedSessionKey,
        sessions,
    ]);

    const sessionOptions = sessionsForSelectedAgent
        .filter((session) => hasSessionKey(session))
        .map((session) => ({
            value: session.key,
            label: formatChatSessionLabel(session, selectedAgentId),
            description: `${formatSessionType(session)} · ${session.model || "Unknown"}`,
        }));
    const agentSessionCounts = new Map<string, number>();
    for (const session of sortedSessions.filter((entry) => hasSessionKey(entry))) {
        const agentId = getChatAgentId(session);
        agentSessionCounts.set(agentId, (agentSessionCounts.get(agentId) || 0) + 1);
    }
    const agentOptions = [...agentSessionCounts].map(([agentId, count]) => {
        const agent = agents.find((entry) => normalizeChatAgentId(entry.id) === agentId);
        return {
            value: agentId,
            label: agentId,
            description: `${count} session${count === 1 ? "" : "s"}${agent?.status ? ` · ${agent.status}` : ""}`,
        };
    });

    const selectAgent = (agentId: string) => {
        if (agentId === selectedAgentId) return;
        const agentSession = agents.find(
            (agent) => normalizeChatAgentId(agent.id) === agentId
        )?.sessionKey;
        const nextSession =
            sortedSessions.find(
                (session) =>
                    hasSessionKey(session) &&
                    isSameChatSession(session.key, agentSession) &&
                    getChatAgentId(session) === agentId
            ) ||
            sortedSessions.find(
                (session) => hasSessionKey(session) && getChatAgentId(session) === agentId
            );
        if (nextSession) selectSession(nextSession.key);
    };

    return {
        agentOptions,
        requestedSessionKey,
        selectedAgentId,
        selectedSession,
        selectedSessionKey,
        selectedSessionUpdatedAt: selectedSession?.updatedAt,
        selectAgent,
        selectSession,
        sessionOptions,
    };
}
