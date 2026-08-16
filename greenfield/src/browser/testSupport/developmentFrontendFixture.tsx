import { useState } from "react";
import { createRoot } from "react-dom/client";

export function DevelopmentFrontendFixture() {
    const [count, setCount] = useState(0);
    return <button onClick={() => setCount((value) => value + 1)}>{count}</button>;
}

const developmentFrontendFixtureRoot = document.querySelector(
    "#development-frontend-fixture"
);
if (developmentFrontendFixtureRoot === null) {
    throw new Error("Development frontend fixture root is unavailable");
}
createRoot(developmentFrontendFixtureRoot).render(<DevelopmentFrontendFixture />);
