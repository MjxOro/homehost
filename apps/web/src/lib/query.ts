import {
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  AgentConversation,
  DashboardResponse,
  PortalUser,
  ServerRequest,
  SessionResponse,
} from "@homehost/shared";
import { api, ApiError } from "./api";

export const queryKeys = {
  session: ["session"] as const,
  conversations: ["agent-conversations"] as const,
  conversation: ["agent-conversation"] as const,
  plans: ["plans"] as const,
  dashboard: ["dashboard"] as const,
  approvals: ["approvals"] as const,
  instances: ["instances"] as const,
};

/** Transport-level failure (fetch threw). HTTP 4xx/5xx are NOT network errors. */
export function isNetworkError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 0;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => isNetworkError(error) && failureCount < 2,
    },
  },
});

/**
 * Persona switch / logout must never leak one tenant's cached data to another.
 * In-flight tenant queries are cancelled and their caches dropped, while the
 * observed session query and the public plans catalog are preserved (clear()
 * would unmount-session the whole shell). The caller then seeds the fresh
 * session response via setQueryData.
 */
async function clearTenantData(queryClient: QueryClient) {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: queryKeys.session }),
    queryClient.cancelQueries({ queryKey: queryKeys.dashboard }),
    queryClient.cancelQueries({ queryKey: queryKeys.approvals }),
    queryClient.cancelQueries({ queryKey: queryKeys.conversations }),
    queryClient.cancelQueries({ queryKey: queryKeys.conversation }),
  ]);
  queryClient.removeQueries({ queryKey: queryKeys.dashboard });
  queryClient.removeQueries({ queryKey: queryKeys.approvals });
  queryClient.removeQueries({ queryKey: queryKeys.conversations });
  queryClient.removeQueries({ queryKey: queryKeys.conversation });
}

export function useSession() {
  return useQuery({
    queryKey: queryKeys.session,
    queryFn: api.getSession,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

/** Public catalog endpoint — safe to call signed out. */
export function usePlans() {
  return useQuery({
    queryKey: queryKeys.plans,
    queryFn: api.getPlans,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * Keyed by user id so two personas never share a dashboard cache entry.
 * `pollMs` lets a page watching a request poll faster until it settles.
 */
export function useDashboard(
  userId: string | undefined,
  pollMs: (data: DashboardResponse | undefined) => number = () => 10_000,
) {
  return useQuery({
    queryKey: [...queryKeys.dashboard, userId ?? "none"],
    queryFn: api.getDashboard,
    enabled: typeof userId === "string" && userId.length > 0,
    // Worker-driven transitions (approved→provisioning→running, stop/start)
    // land server-side; poll so rows converge without a manual refresh.
    refetchInterval: (query) => pollMs(query.state.data),
  });
}

/** Operator-only queue, keyed by user id and enabled only for a real operator session. */
export function useApprovals(user: PortalUser | null | undefined) {
  const isOperator = user?.role === "operator";
  return useQuery({
    queryKey: [...queryKeys.approvals, user?.id ?? "none"],
    queryFn: api.getApprovals,
    enabled: isOperator,
    refetchInterval: isOperator ? 15_000 : false,
  });
}

/** Operator-only provisioned fleet, same gating as the approval queue. */
export function useInstances(user: PortalUser | null | undefined) {
  const isOperator = user?.role === "operator";
  return useQuery({
    queryKey: [...queryKeys.instances, user?.id ?? "none"],
    queryFn: api.getInstances,
    enabled: isOperator,
    refetchInterval: isOperator ? 15_000 : false,
  });
}

export function useSwitchPersona() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (personaId: string) => api.switchPersona(personaId),
    onSuccess: async (session) => {
      await clearTenantData(queryClient);
      queryClient.setQueryData(queryKeys.session, session);
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.logout,
    onSuccess: async () => {
      const current = queryClient.getQueryData<SessionResponse>(
        queryKeys.session,
      );
      await clearTenantData(queryClient);
      queryClient.setQueryData<SessionResponse>(queryKeys.session, {
        mode: current?.mode ?? "showcase",
        user: null,
        personas: current?.personas ?? [],
        providers: current?.providers ?? { google: false, github: false },
      });
    },
  });
}

/**
 * Mutations affect whichever tenant is signed in; invalidating by prefix
 * catches every per-user cache entry.
 */
function useInvalidateAfterMutation() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
    void queryClient.invalidateQueries({ queryKey: queryKeys.approvals });
    void queryClient.invalidateQueries({ queryKey: queryKeys.conversation });
    void queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
  };
}

/**
 * Puts a request the API just returned into every cached dashboard, so a page
 * navigated to right after a create or retry shows it without waiting for
 * the refetch the invalidation triggers.
 */
function useUpsertRequest() {
  const queryClient = useQueryClient();
  return (request: ServerRequest) => {
    queryClient.setQueriesData<DashboardResponse>(
      { queryKey: queryKeys.dashboard },
      (old) =>
        old && {
          ...old,
          requests: [
            request,
            ...old.requests.filter((row) => row.id !== request.id),
          ],
        },
    );
  };
}

export function useCreateRequest() {
  const invalidate = useInvalidateAfterMutation();
  const upsert = useUpsertRequest();
  return useMutation({
    mutationFn: api.createRequest,
    onSuccess: (request) => {
      upsert(request);
      invalidate();
    },
  });
}

export function useRetrySetup() {
  const invalidate = useInvalidateAfterMutation();
  const upsert = useUpsertRequest();
  return useMutation({
    mutationFn: api.retrySetup,
    onSuccess: (request) => {
      upsert(request);
      invalidate();
    },
  });
}

export function useCancelRequest() {
  const invalidate = useInvalidateAfterMutation();
  return useMutation({
    mutationFn: api.cancelRequest,
    onSuccess: invalidate,
  });
}

export function useStopInstance() {
  const invalidate = useInvalidateAfterMutation();
  return useMutation({
    mutationFn: api.stopInstance,
    onSuccess: invalidate,
  });
}

export function useStartInstance() {
  const invalidate = useInvalidateAfterMutation();
  return useMutation({
    mutationFn: api.startInstance,
    onSuccess: invalidate,
  });
}

export function useRetryProvision() {
  const invalidate = useInvalidateAfterMutation();
  return useMutation({
    mutationFn: api.retryProvision,
    onSuccess: invalidate,
  });
}

/**
 * One-time password fetch. Deliberately a bare mutation: the secret must
 * never sit in the query cache, and success invalidates nothing.
 */
export function useCredentials() {
  return useMutation({
    mutationFn: (id: string) => api.getCredentials(id),
  });
}

/**
 * Concierge suggestion from free text. Creates nothing server-side, so success
 * invalidates nothing; each call counts against the daily cap.
 */
export function useSuggest() {
  return useMutation({
    mutationFn: api.suggest,
  });
}

/**
 * Desktop session URL: same-origin proxied KasmVNC canvas. A query (not a
 * mutation): the secret never leaves the server, the URL carries only
 * Kasm's `?password=` RFB autoconnect query, and refresh must re-fetch.
 */
export function useDesktopSession(id: string | undefined) {
  return useQuery({
    queryKey: ["desktop-session", id ?? "none"],
    queryFn: () => api.getDesktopSession(id ?? ""),
    enabled: typeof id === "string" && id.length > 0,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function useDecide() {
  const invalidate = useInvalidateAfterMutation();
  return useMutation({
    mutationFn: (input: {
      id: string;
      decision: "approve" | "reject";
      reason: string;
    }) => api.decide(input.id, input.decision, input.reason),
    onSuccess: invalidate,
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) invalidate();
    },
  });
}

export function useAgentConversations(userId: string | undefined) {
  return useQuery({
    queryKey: [...queryKeys.conversations, userId ?? "none"],
    queryFn: api.listConversations,
    enabled: !!userId,
    refetchInterval: (q) =>
      q.state.data?.some((c) => c.settingUp || c.status !== "idle")
        ? 2500
        : 10000,
  });
}
export function useAgentConversation(userId: string | undefined, id: string) {
  return useQuery({
    queryKey: [...queryKeys.conversation, userId ?? "none", id],
    queryFn: () => api.getConversation(id),
    enabled: !!userId && !!id,
    refetchInterval: (q) =>
      q.state.data?.settingUp || q.state.data?.status === "running"
        ? 2500
        : 10000,
  });
}
export function useAgentTurn(userId: string | undefined, id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (text: string | undefined) => api.agentTurn(id, text),
    onSuccess: (c: AgentConversation) =>
      client.setQueryData([...queryKeys.conversation, userId ?? "none", id], c),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.conversation });
      void client.invalidateQueries({ queryKey: queryKeys.conversations });
    },
  });
}
