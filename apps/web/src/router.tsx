import {
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { AgentChatPage, AgentConversationsPage } from "./routes/agent-chat";
import { AppLayout } from "./components/AppLayout";
import { ApprovalsPage } from "./routes/approvals";
import { AdminPage } from "./pages/Admin";
import { DashboardPage } from "./routes/dashboard";
import { DesktopLoginPage } from "./routes/desktop-login";
import { NewRequestPage } from "./routes/new-request";
import { NotFoundPage } from "./routes/not-found";
import { ServerProgressPage } from "./routes/server-progress";
const rootRoute = createRootRoute({
  component: AppLayout,
  notFoundComponent: NotFoundPage,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: DashboardPage,
});

const newRequestRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/new",
  component: NewRequestPage,
});

const approvalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/approvals",
  component: ApprovalsPage,
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  component: AdminPage,
});
const desktopRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/desktop/$id",
  component: DesktopLoginPage,
});
const serverProgressRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/servers/$id",
  component: ServerProgressPage,
});
const agentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agent",
  component: AgentConversationsPage,
});
const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat/$id",
  component: AgentChatPage,
});
const routeTree = rootRoute.addChildren([
  indexRoute,
  agentRoute,
  chatRoute,
  newRequestRoute,
  approvalsRoute,
  adminRoute,
  desktopRoute,
  serverProgressRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  // Cross-fades the `.vt-page` column between routes where the browser
  // supports View Transitions; elsewhere navigation is instant as before.
  defaultViewTransition: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
