import { OrbitControls, Text } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";

import { Card } from "../components/ui/Card";
import { LoadingState } from "../components/ui/LoadingState";
import { useAgentsStatus } from "../hooks/useAgents";
import type { Agent } from "../types/session";

interface DeskSpot {
    agentId: string;
    deskPosition: [number, number, number];
    workPosition: [number, number, number];
}

interface IdlePoint {
    position: [number, number, number];
    action: "walk" | "water" | "copy" | "chat";
}

interface AgentRuntime {
    id: string;
    displayName: string;
    isFemale: boolean;
    status: Agent["status"];
    color: string;
    role: string;
    startPosition: [number, number, number];
    workPosition: [number, number, number];
    idlePoints: IdlePoint[];
    speed: number;
}

interface CircleObstacle {
    x: number;
    z: number;
    radius: number;
}

const deskSpots: DeskSpot[] = [
    { agentId: "main", deskPosition: [0, 0, 3.8], workPosition: [0, -0.02, 4.73] },
    {
        agentId: "researcher",
        deskPosition: [-6, 0, -4],
        workPosition: [-6, -0.02, -3.03],
    },
    { agentId: "coder", deskPosition: [-2, 0, -4], workPosition: [-2, -0.02, -3.03] },
    {
        agentId: "communicator",
        deskPosition: [2, 0, -4],
        workPosition: [2, -0.02, -3.03],
    },
    { agentId: "monitor", deskPosition: [6, 0, -4], workPosition: [6, -0.02, -3.03] },
];

const baseIdlePoints: IdlePoint[] = [
    { position: [-9.3, -0.02, 6.1], action: "water" },
    { position: [6.8, -0.02, 6.1], action: "copy" },
    { position: [-3.2, -0.02, 1.1], action: "chat" },
    { position: [3.2, -0.02, 1.1], action: "chat" },
    { position: [-5.4, -0.02, 2.1], action: "walk" },
    { position: [5.4, -0.02, 2.1], action: "walk" },
    { position: [0, -0.02, 7.2], action: "walk" },
];

const officeObstacles: CircleObstacle[] = [
    ...deskSpots.map((desk) => ({
        x: desk.deskPosition[0],
        z: desk.deskPosition[2],
        radius: desk.agentId === "main" ? 2.2 : 1.1,
    })),
    { x: -8.4, z: 6, radius: 0.9 },
    { x: 8.4, z: 6, radius: 1.05 },
];

const roleById: Record<string, string> = {
    main: "Chief of Staff",
    researcher: "Research Specialist",
    coder: "Engineering Specialist",
    communicator: "Communication Specialist",
    monitor: "Operations Monitor",
};

const statusColor: Record<Agent["status"], string> = {
    active: "#22c55e",
    thinking: "#f59e0b",
    idle: "#38bdf8",
    offline: "#6b7280",
};

const MIN_X = -10.1;
const MAX_X = 10.1;
const MIN_Z = -8.1;
const MAX_Z = 8.1;

export function Office3D() {
    const { data, isLoading, error } = useAgentsStatus();
    const liveAgents = data?.agents || [];

    const runtimeAgents: AgentRuntime[] = liveAgents
        .filter((agent) => agent.status !== "offline")
        .map((agent, index) => {
            const desk =
                deskSpots.find((spot) => spot.agentId === agent.id) ||
                buildFallbackDesk(agent.id, index);
            return {
                id: agent.id,
                displayName:
                    agent.id === "main"
                        ? "Mira"
                        : agent.id.charAt(0).toUpperCase() + agent.id.slice(1),
                isFemale: isFemaleAgent(agent.id),
                status: agent.status,
                color: statusColor[agent.status],
                role: roleById[agent.id] || "Agent",
                startPosition: [desk.workPosition[0], -0.02, desk.workPosition[2] + 0.55],
                workPosition: desk.workPosition,
                idlePoints: shuffleIdlePoints(baseIdlePoints, agent.id),
                speed: 0.9 + hashNumber(agent.id) * 0.35,
            };
        });

    if (error) {
        return (
            <div className="space-y-4 p-6">
                <Card className="rounded-lg bg-red-500/20 p-4 text-red-300">
                    {error instanceof Error
                        ? error.message
                        : "Failed to load office data"}
                </Card>
            </div>
        );
    }

    if (isLoading) {
        return (
            <div className="space-y-4 p-6">
                <Card>
                    <LoadingState size="lg" message="Loading office simulation..." />
                </Card>
            </div>
        );
    }

    return (
        <div className="space-y-4 p-6">
            <Card className="space-y-2">
                <p className="text-sm text-primary-200">
                    Live office simulation: idle agents walk, pause at water/copy
                    stations, and stop for short chats. Thinking or active agents work at
                    their desks. Offline agents are not present.
                </p>
                <div className="flex flex-wrap gap-2 text-xs">
                    <LegendDot
                        color="bg-sky-400"
                        label="Idle (walking / micro-actions)"
                    />
                    <LegendDot color="bg-amber-400" label="Thinking (working)" />
                    <LegendDot color="bg-emerald-400" label="Active (working)" />
                </div>
            </Card>

            <Card className="p-2">
                <div className="h-[680px] overflow-hidden rounded-lg border border-primary-700 bg-primary-950">
                    <Canvas camera={{ position: [0, 14, 21], fov: 44 }} shadows>
                        <OfficeScene agents={runtimeAgents} />
                    </Canvas>
                </div>
            </Card>
        </div>
    );
}

function OfficeScene({ agents }: { agents: AgentRuntime[] }) {
    return (
        <>
            <color attach="background" args={["#7f91a8"]} />
            <fog attach="fog" args={["#7f91a8", 24, 56]} />

            <ambientLight intensity={0.8} />
            <directionalLight
                castShadow
                intensity={1.15}
                position={[9, 14, 3]}
                color="#ffffff"
                shadow-mapSize-width={1024}
                shadow-mapSize-height={1024}
            />
            <CeilingLights />
            <hemisphereLight intensity={0.58} color="#ffffff" groundColor="#94a3b8" />

            <mesh position={[0, -0.05, 0]} receiveShadow>
                <boxGeometry args={[22, 0.1, 18]} />
                <meshStandardMaterial color="#9eafc3" roughness={0.86} metalness={0.05} />
            </mesh>

            <OfficeWalls />
            <OfficeEquipment />
            <DeskCluster />

            {agents.map((agent) => (
                <AgentAvatar key={agent.id} agent={agent} />
            ))}

            <OrbitControls
                enablePan
                enableZoom
                minDistance={11}
                maxDistance={31}
                minPolarAngle={0.35}
                maxPolarAngle={1.35}
            />
        </>
    );
}

function CeilingLights() {
    const lights: Array<[number, number, number]> = [
        [-7, 3.6, -2],
        [0, 3.6, -2],
        [7, 3.6, -2],
        [-7, 3.6, 4],
        [0, 3.6, 4],
        [7, 3.6, 4],
    ];

    return (
        <>
            {lights.map((position, index) => (
                <pointLight
                    key={`light-${index}`}
                    intensity={0.43}
                    distance={10}
                    color="#f1f5f9"
                    position={position}
                />
            ))}
        </>
    );
}

function OfficeWalls() {
    return (
        <>
            <mesh position={[0, 2, -9]} receiveShadow>
                <boxGeometry args={[22, 4, 0.25]} />
                <meshStandardMaterial color="#f1f5f9" />
            </mesh>
            <mesh position={[-11, 2, 0]} receiveShadow>
                <boxGeometry args={[0.25, 4, 18]} />
                <meshStandardMaterial color="#f1f5f9" />
            </mesh>
            <mesh position={[11, 2, 0]} receiveShadow>
                <boxGeometry args={[0.25, 4, 18]} />
                <meshStandardMaterial color="#f1f5f9" />
            </mesh>
        </>
    );
}

function OfficeEquipment() {
    return (
        <>
            <group position={[-8.4, 0, 6]}>
                <mesh castShadow position={[0, 0.75, 0]}>
                    <boxGeometry args={[0.95, 1.5, 0.95]} />
                    <meshStandardMaterial color="#e2e8f0" />
                </mesh>
                <mesh castShadow position={[0, 1.62, 0]}>
                    <cylinderGeometry args={[0.38, 0.38, 0.26, 24]} />
                    <meshStandardMaterial
                        color="#7dd3fc"
                        emissive="#38bdf8"
                        emissiveIntensity={0.2}
                    />
                </mesh>
            </group>

            <group position={[8.4, 0, 6]}>
                <mesh castShadow position={[0, 0.7, 0]}>
                    <boxGeometry args={[1.9, 1.4, 1.25]} />
                    <meshStandardMaterial color="#cbd5e1" />
                </mesh>
                <mesh castShadow position={[0, 1.48, 0]}>
                    <boxGeometry args={[1.55, 0.12, 1.05]} />
                    <meshStandardMaterial color="#94a3b8" />
                </mesh>
                <mesh castShadow position={[0.45, 1.07, 0.56]}>
                    <boxGeometry args={[0.55, 0.07, 0.08]} />
                    <meshStandardMaterial color="#64748b" />
                </mesh>
            </group>

            <Plant position={[-10, 0, -7]} />
            <Plant position={[10, 0, -7]} />
        </>
    );
}

function Plant({ position }: { position: [number, number, number] }) {
    return (
        <group position={position}>
            <mesh castShadow position={[0, 0.25, 0]}>
                <cylinderGeometry args={[0.25, 0.31, 0.5, 18]} />
                <meshStandardMaterial color="#7c2d12" />
            </mesh>
            <mesh castShadow position={[0, 0.78, 0]}>
                <sphereGeometry args={[0.5, 24, 24]} />
                <meshStandardMaterial color="#22c55e" />
            </mesh>
        </group>
    );
}

function DeskCluster() {
    return (
        <>
            {deskSpots.map((spot) => (
                <DeskUnit
                    key={spot.agentId}
                    position={spot.deskPosition}
                    isMain={spot.agentId === "main"}
                />
            ))}
        </>
    );
}

function DeskUnit({
    position,
    isMain,
}: {
    position: [number, number, number];
    isMain: boolean;
}) {
    const topWidth = isMain ? 2.7 : 2.25;
    const topDepth = isMain ? 1.45 : 1.25;
    const legX = isMain ? 1.18 : 0.97;
    const legZ = isMain ? 0.58 : 0.48;

    return (
        <group position={position}>
            <mesh castShadow position={[0, 0.61, 0]}>
                <boxGeometry args={[topWidth, 0.13, topDepth]} />
                <meshStandardMaterial color={isMain ? "#475569" : "#334155"} />
            </mesh>

            {[
                [-legX, 0.3, -legZ],
                [legX, 0.3, -legZ],
                [-legX, 0.3, legZ],
                [legX, 0.3, legZ],
            ].map((leg) => (
                <mesh
                    key={`leg-${leg[0]}-${leg[2]}`}
                    castShadow
                    position={leg as [number, number, number]}
                >
                    <boxGeometry args={[0.08, 0.6, 0.08]} />
                    <meshStandardMaterial color="#475569" />
                </mesh>
            ))}

            <mesh castShadow position={[0, 0.98, -0.34]}>
                <boxGeometry args={isMain ? [0.95, 0.5, 0.05] : [0.78, 0.46, 0.05]} />
                <meshStandardMaterial
                    color="#67e8f9"
                    emissive="#0891b2"
                    emissiveIntensity={0.28}
                />
            </mesh>
            <mesh castShadow position={[0, 0.78, -0.405]}>
                <boxGeometry args={[0.09, 0.36, 0.06]} />
                <meshStandardMaterial color="#64748b" />
            </mesh>
            <mesh castShadow position={[0, 0.66, -0.405]}>
                <boxGeometry args={[0.28, 0.03, 0.2]} />
                <meshStandardMaterial color="#64748b" />
            </mesh>
            <mesh castShadow position={[0, 0.98, -0.375]}>
                <boxGeometry args={isMain ? [0.99, 0.54, 0.02] : [0.82, 0.5, 0.02]} />
                <meshStandardMaterial color="#1e293b" />
            </mesh>

            <mesh castShadow position={[0, 0.69, 0.2]}>
                <boxGeometry args={[0.64, 0.03, 0.24]} />
                <meshStandardMaterial color="#f1f5f9" />
            </mesh>
            <mesh castShadow position={[0.52, 0.682, 0.2]}>
                <boxGeometry args={[0.24, 0.01, 0.21]} />
                <meshStandardMaterial color="#334155" />
            </mesh>
            <mesh castShadow position={[0.52, 0.695, 0.2]}>
                <cylinderGeometry args={[0.045, 0.045, 0.022, 16]} />
                <meshStandardMaterial color="#e2e8f0" />
            </mesh>

            <OfficeChair position={[0, 0, 0.96]} isMain={isMain} />
        </group>
    );
}

function OfficeChair({
    position,
    isMain,
}: {
    position: [number, number, number];
    isMain: boolean;
}) {
    return (
        <group position={position} rotation={[0, Math.PI, 0]}>
            <mesh castShadow position={[0, 0.37, 0]}>
                <boxGeometry args={isMain ? [0.72, 0.1, 0.72] : [0.62, 0.1, 0.62]} />
                <meshStandardMaterial color={isMain ? "#475569" : "#334155"} />
            </mesh>
            <mesh castShadow position={[0, 0.72, -0.27]}>
                <boxGeometry args={isMain ? [0.72, 0.62, 0.1] : [0.62, 0.55, 0.1]} />
                <meshStandardMaterial color={isMain ? "#64748b" : "#475569"} />
            </mesh>
            <mesh castShadow position={[0, 0.2, 0]}>
                <cylinderGeometry args={[0.08, 0.08, 0.28, 16]} />
                <meshStandardMaterial color="#475569" />
            </mesh>
            <mesh castShadow position={[0, 0.05, 0]}>
                <cylinderGeometry args={[0.33, 0.33, 0.04, 16]} />
                <meshStandardMaterial color="#334155" />
            </mesh>
        </group>
    );
}

function AgentAvatar({ agent }: { agent: AgentRuntime }) {
    const groupRef = useRef<THREE.Group>(null);
    const targetRef = useRef(new THREE.Vector3(...agent.startPosition));
    const pointIndexRef = useRef(0);
    const holdTimerRef = useRef(0);
    const travelTimerRef = useRef(0);

    useFrame((state, delta) => {
        const group = groupRef.current;
        if (!group) return;

        const position = group.position;
        const target = targetRef.current;

        if (agent.status === "active" || agent.status === "thinking") {
            target.set(...agent.workPosition);
            travelTimerRef.current = 0;
            holdTimerRef.current = 0;
        } else {
            holdTimerRef.current -= delta;
            travelTimerRef.current += delta;

            const currentPoint = agent.idlePoints[pointIndexRef.current];
            const reached = position.distanceTo(target) < 0.22;
            const shouldAdvanceWaypoint =
                (holdTimerRef.current <= 0 && reached) || travelTimerRef.current > 8;

            if (shouldAdvanceWaypoint) {
                pointIndexRef.current =
                    (pointIndexRef.current + 1) % agent.idlePoints.length;
                const nextPoint = agent.idlePoints[pointIndexRef.current];
                target.set(...nextPoint.position);
                holdTimerRef.current = actionPauseSeconds(nextPoint.action, agent.id);
                travelTimerRef.current = 0;
            } else if (reached && holdTimerRef.current <= 0) {
                holdTimerRef.current = actionPauseSeconds(currentPoint.action, agent.id);
            }
        }

        const toTarget = new THREE.Vector3().subVectors(target, position);
        const distance = toTarget.length();

        const isWorking = agent.status === "active" || agent.status === "thinking";

        if (distance > 0.02 && holdTimerRef.current <= 0.1) {
            toTarget.normalize();
            const step = Math.min(distance, delta * agent.speed * 1.45);
            const next = position.clone().addScaledVector(toTarget, step);
            keepInsideBounds(next);

            if (!isWorking) {
                avoidObstacles(next, position);
            }

            position.copy(next);
            if (!isWorking) {
                group.rotation.y = Math.atan2(toTarget.x, toTarget.z);
            }
        }

        if (isWorking) {
            group.rotation.y = Math.PI;
        }

        if (agent.status === "idle" && holdTimerRef.current > 0.2) {
            const currentPoint = agent.idlePoints[pointIndexRef.current];
            if (currentPoint.action === "chat") {
                const chatCenter = new THREE.Vector3(0, position.y, 0.9);
                const chatVector = new THREE.Vector3().subVectors(chatCenter, position);
                if (chatVector.length() > 0.05) {
                    group.rotation.y = Math.atan2(chatVector.x, chatVector.z);
                }
            }
        }

        const bob =
            agent.status === "idle"
                ? Math.sin(state.clock.elapsedTime * 4 + hashNumber(agent.id) * 10) *
                  0.012
                : 0;
        group.position.y = -0.02 + bob;
    });

    const isWorkingPose = agent.status === "active" || agent.status === "thinking";
    const hairColor = hairColorByAgent(agent.id);
    const leftArmPosition: [number, number, number] = isWorkingPose
        ? [-0.19, 0.73, 0.15]
        : [-0.16, 0.5, 0];
    const rightArmPosition: [number, number, number] = isWorkingPose
        ? [0.19, 0.73, 0.15]
        : [0.16, 0.5, 0];
    const armRotation: [number, number, number] = isWorkingPose
        ? [-1.35, 0, 0]
        : [0, 0, 0];

    return (
        <group ref={groupRef} position={agent.startPosition}>
            <mesh castShadow position={[0, 0.54, 0]}>
                <capsuleGeometry args={[0.17, 0.36, 4, 10]} />
                <meshStandardMaterial
                    color={agent.color}
                    emissive={agent.color}
                    emissiveIntensity={0.18}
                />
            </mesh>
            <mesh castShadow position={[0, 0.88, 0]}>
                <sphereGeometry args={[0.14, 20, 20]} />
                <meshStandardMaterial color="#f8fafc" roughness={0.35} />
            </mesh>
            {agent.isFemale ? (
                <>
                    <mesh castShadow position={[0, 0.96, -0.01]}>
                        <sphereGeometry args={[0.15, 20, 20]} />
                        <meshStandardMaterial color={hairColor} roughness={0.55} />
                    </mesh>
                    <mesh castShadow position={[-0.07, 0.79, -0.09]}>
                        <boxGeometry args={[0.1, 0.2, 0.08]} />
                        <meshStandardMaterial color={hairColor} roughness={0.55} />
                    </mesh>
                    <mesh castShadow position={[0.07, 0.79, -0.09]}>
                        <boxGeometry args={[0.1, 0.2, 0.08]} />
                        <meshStandardMaterial color={hairColor} roughness={0.55} />
                    </mesh>
                </>
            ) : (
                <mesh castShadow position={[0, 0.97, 0]}>
                    <sphereGeometry args={[0.145, 20, 20]} />
                    <meshStandardMaterial color={hairColor} roughness={0.6} />
                </mesh>
            )}
            <mesh castShadow position={[-0.05, 0.9, 0.12]}>
                <sphereGeometry args={[0.014, 12, 12]} />
                <meshStandardMaterial color="#0f172a" />
            </mesh>
            <mesh castShadow position={[0.05, 0.9, 0.12]}>
                <sphereGeometry args={[0.014, 12, 12]} />
                <meshStandardMaterial color="#0f172a" />
            </mesh>
            <mesh castShadow position={[0, 0.885, 0.125]}>
                <coneGeometry args={[0.016, 0.045, 12]} />
                <meshStandardMaterial color="#0f172a" />
            </mesh>
            <mesh castShadow position={[0, 0.82, 0.125]}>
                <boxGeometry args={[0.04, 0.006, 0.008]} />
                <meshStandardMaterial color="#0f172a" />
            </mesh>
            <mesh castShadow position={leftArmPosition} rotation={armRotation}>
                <capsuleGeometry args={[0.045, 0.22, 4, 8]} />
                <meshStandardMaterial color={agent.color} />
            </mesh>
            <mesh castShadow position={rightArmPosition} rotation={armRotation}>
                <capsuleGeometry args={[0.045, 0.22, 4, 8]} />
                <meshStandardMaterial color={agent.color} />
            </mesh>
            <mesh castShadow position={[-0.08, 0.2, 0]}>
                <capsuleGeometry args={[0.05, 0.26, 4, 8]} />
                <meshStandardMaterial color="#1e293b" />
            </mesh>
            <mesh castShadow position={[0.08, 0.2, 0]}>
                <capsuleGeometry args={[0.05, 0.26, 4, 8]} />
                <meshStandardMaterial color="#1e293b" />
            </mesh>

            <Text
                position={[0, 1.38, 0]}
                fontSize={0.18}
                color="#e2e8f0"
                anchorX="center"
                anchorY="middle"
                outlineWidth={0.012}
                outlineColor="#020617"
            >
                {agent.displayName}
            </Text>
            <Text
                position={[0, 1.19, 0]}
                fontSize={0.12}
                color="#93c5fd"
                anchorX="center"
                anchorY="middle"
                outlineWidth={0.01}
                outlineColor="#020617"
            >
                {agent.role}
            </Text>
        </group>
    );
}

function isFemaleAgent(agentId: string): boolean {
    return agentId === "main" || agentId === "communicator" || agentId === "researcher";
}

function hairColorByAgent(agentId: string): string {
    if (agentId === "main") return "#2f1f16";
    if (agentId === "communicator") return "#6b3f24";
    if (agentId === "researcher") return "#c09062";
    if (agentId === "coder") return "#1f2937";
    return "#5b4636";
}

function actionPauseSeconds(action: IdlePoint["action"], seed: string): number {
    if (action === "water") return 2 + hashNumber(seed + "water") * 1.5;
    if (action === "copy") return 2.2 + hashNumber(seed + "copy") * 1.8;
    if (action === "chat") return 1.7 + hashNumber(seed + "chat") * 1.6;
    return 0.8 + hashNumber(seed + "walk") * 0.8;
}

function buildFallbackDesk(agentId: string, index: number): DeskSpot {
    const x = -6 + (index % 4) * 4;
    const z = 3.5 + Math.floor(index / 4) * 3;
    return { agentId, deskPosition: [x, 0, z], workPosition: [x, -0.02, z + 0.7] };
}

function keepInsideBounds(position: THREE.Vector3) {
    position.x = Math.max(MIN_X, Math.min(MAX_X, position.x));
    position.z = Math.max(MIN_Z, Math.min(MAX_Z, position.z));
}

function avoidObstacles(next: THREE.Vector3, current: THREE.Vector3) {
    for (const obstacle of officeObstacles) {
        const dx = next.x - obstacle.x;
        const dz = next.z - obstacle.z;
        const distance = Math.hypot(dx, dz);
        const minDistance = obstacle.radius + 0.28;

        if (distance < minDistance) {
            const nx = distance > 0.001 ? dx / distance : next.x >= obstacle.x ? 1 : -1;
            const nz = distance > 0.001 ? dz / distance : next.z >= obstacle.z ? 1 : -1;
            next.x = obstacle.x + nx * minDistance;
            next.z = obstacle.z + nz * minDistance;

            if (
                Math.abs(next.x - current.x) < 0.001 &&
                Math.abs(next.z - current.z) < 0.001
            ) {
                next.x += nx * 0.06;
                next.z += nz * 0.06;
            }
        }
    }
}

function hashNumber(seed: string | number): number {
    const text = String(seed);
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
        hash = (hash << 5) - hash + (text.codePointAt(i) || 0);
        hash = Math.trunc(hash);
    }
    return Math.abs(hash % 1000) / 1000;
}

function shuffleIdlePoints(points: IdlePoint[], seed: string): IdlePoint[] {
    const items = [...points];
    for (let i = items.length - 1; i > 0; i -= 1) {
        const j = Math.floor(hashNumber(seed + i) * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
}

function LegendDot({ color, label }: { color: string; label: string }) {
    return (
        <span className="inline-flex items-center gap-1.5 rounded-md border border-primary-700 px-2 py-1 text-primary-300">
            <span className={`h-2 w-2 rounded-full ${color}`} />
            {label}
        </span>
    );
}
