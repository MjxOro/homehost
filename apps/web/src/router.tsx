import {
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { AppLayout } from "./components/AppLayout";
import { ApprovalsPage } from "./routes/approvals";
import { AdminPage } from "./pages/Admin";
import { DashboardPage } from "./routes/dashboard";
import { DesktopLoginPage } from "./routes/desktop-login";
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
const routeTree = rootRoute.addChildren([
  indexRoute,
  newRequestRoute,
  approvalsRoute,
  adminRoute,
  desktopRoute,
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
