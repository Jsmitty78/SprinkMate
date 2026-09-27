import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import { WorkbenchApp } from "./workbench/WorkbenchApp.js";

// The earlier Japanese task UI stays reachable at /legacy. Its global stylesheet loads only there.
const Legacy = lazy(async () => {
  await import("./styles.css");
  const { App } = await import("./App.js");
  return { default: App };
});

const legacy = location.pathname === "/legacy" || location.pathname.startsWith("/legacy/");
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{legacy ? <Suspense fallback={null}><Legacy /></Suspense> : <WorkbenchApp />}</React.StrictMode>,
);
