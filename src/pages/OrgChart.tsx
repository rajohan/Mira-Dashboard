import { Badge } from "../components/ui/Badge";
import { Card, CardTitle } from "../components/ui/Card";

interface AgentCardData {
    id: string;
    role: string;
    department: string;
    description: string;
}

const agentCards: AgentCardData[] = [
    {
        id: "researcher",
        role: "Research Specialist",
        department: "Research",
        description: "Finds and validates external information with sources.",
    },
    {
        id: "coder",
        role: "Engineering Specialist",
        department: "Development",
        description: "Implements features, fixes bugs, and handles technical execution.",
    },
    {
        id: "communicator",
        role: "Communication Specialist",
        department: "Communications",
        description: "Drafts high-quality messages, announcements, and outbound content.",
    },
    {
        id: "ops",
        role: "Operations Agent",
        department: "Operations",
        description: "Runs heartbeat checks, monitors systems, and surfaces actionable issues.",
    },
];

export function OrgChart() {
    return (
        <div className="p-6">
            <div className="mx-auto max-w-6xl">
                <div className="flex flex-col items-center">
                    <LeadershipCard
                        name="Raymond"
                        title="Chief Executive Officer"
                        accentClass="border-emerald-500/50 bg-emerald-500/10"
                    />

                    <div className="h-8 w-px bg-primary-600" />

                    <LeadershipCard
                        name="Mira"
                        title="Chief of Staff"
                        accentClass="border-blue-500/50 bg-blue-500/10"
                    />

                    <div className="hidden h-8 w-px bg-primary-600 lg:block" />
                </div>

                <div className="relative">
                    <div className="absolute left-[calc((100%-3rem)/8)] right-[calc((100%-3rem)/8)] top-0 hidden h-px bg-primary-600 lg:block" />

                    <div className="grid grid-cols-1 gap-4 pt-0 sm:grid-cols-2 lg:grid-cols-4 lg:pt-10">
                        {agentCards.map((agent) => (
                            <div key={agent.id} className="relative">
                                <div className="absolute -top-10 left-1/2 hidden h-10 w-px -translate-x-1/2 bg-primary-600 lg:block" />
                                <AgentRoleCard agent={agent} />
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}

interface LeadershipCardProps {
    name: string;
    title: string;
    accentClass: string;
}

function LeadershipCard({ name, title, accentClass }: LeadershipCardProps) {
    return (
        <Card className={`w-full max-w-sm border ${accentClass} text-center`}>
            <p className="text-2xl font-semibold text-primary-50">{name}</p>
            <p className="mt-1 text-sm font-medium uppercase tracking-wide text-primary-200">
                {title}
            </p>
        </Card>
    );
}

interface AgentRoleCardProps {
    agent: AgentCardData;
}

function AgentRoleCard({ agent }: AgentRoleCardProps) {
    return (
        <Card className="flex h-full flex-col border border-primary-700 bg-primary-800/80 p-4">
            <div className="mb-3 flex items-start justify-between gap-2">
                <CardTitle className="text-base capitalize">{agent.id}</CardTitle>
                <Badge variant="info">{agent.department}</Badge>
            </div>

            <p className="text-sm font-medium text-primary-200">{agent.role}</p>
            <p className="mt-2 min-h-[3.75rem] text-sm leading-5 text-primary-300">
                {agent.description}
            </p>
        </Card>
    );
}
