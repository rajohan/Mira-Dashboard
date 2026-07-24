import "./index.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { preloadAgentsCollection } from "./collections/agents";
import { preloadLogsCollection } from "./collections/logs";
import { preloadSessionsCollection } from "./collections/sessions";
import { installUserActivityTracking } from "./lib/userActivity";

installUserActivityTracking();
preloadAgentsCollection();
preloadLogsCollection();
preloadSessionsCollection();

createRoot(document.querySelector("#root")!).render(
    <StrictMode>
        <App />
    </StrictMode>
);
