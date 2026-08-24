import { createLazyRoute } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";

import { AuthenticationBoundary } from "../auth/AuthenticationBoundary.tsx";
import { ActionLink } from "../ui/ActionLink.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { Text } from "../ui/Text.tsx";

export const Route = createLazyRoute("/")({
    component: function OverviewRoute() {
        return (
            <AuthenticationBoundary>
                <div>
                    <PageHeader
                        description="The secure browser workspace is ready for rewritten Dashboard features as their contracts and services are completed."
                        eyebrow="Dashboard foundation"
                        title="Mira Dashboard"
                    />
                    <Card className="mt-8 max-w-3xl">
                        <output
                            aria-label="Application status"
                            className="flex items-start gap-3"
                        >
                            <Icon
                                className="mt-0.5 size-6 shrink-0 text-emerald-400"
                                icon={ShieldCheck}
                                size="lg"
                                tone="inherit"
                            />
                            <div>
                                <Heading level={2}>Application shell ready</Heading>
                                <Text className="mt-1" tone="muted">
                                    Authentication, account security, delivery, and
                                    runtime boundaries are composed through the greenfield
                                    application.
                                </Text>
                            </div>
                        </output>
                    </Card>
                    <div className="mt-5">
                        <ActionLink to="/account-security">
                            <Icon icon={ShieldCheck} size="sm" tone="inherit" />
                            Manage account security
                        </ActionLink>
                    </div>
                </div>
            </AuthenticationBoundary>
        );
    },
});
