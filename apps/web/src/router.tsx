import {
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { AppLayout } from "./components/AppLayout";
import { ApprovalsPage } from "./routes/approvals";
import { DashboardPage } from "./routes/dashboard";
import { NewRequestPage } from "./routes/new-request";
import { NotFoundPage } from "./routes/not-found";

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

const routeTree = rootRoute.addChildren([
  indexRoute,
  newRequestRoute,
  approvalsRoute,
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
