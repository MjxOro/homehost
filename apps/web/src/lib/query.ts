import {
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { PortalUser, SessionResponse } from "@homehost/shared";
import { api, ApiError } from "./api";

export const queryKeys = {
  session: ["session"] as const,
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
  ]);
  queryClient.removeQueries({ queryKey: queryKeys.dashboard });
  queryClient.removeQueries({ queryKey: queryKeys.approvals });
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

/** Keyed by user id so two personas never share a dashboard cache entry. */
export function useDashboard(userId: string | undefined) {
  return useQuery({
    queryKey: [...queryKeys.dashboard, userId ?? "none"],
    queryFn: api.getDashboard,
    enabled: typeof userId === "string" && userId.length > 0,
    // Worker-driven transitions (approved→provisioning→running, stop/start)
    // land server-side; poll so rows converge without a manual refresh.
    refetchInterval: 10_000,
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
  };
}

export function useCreateRequest() {
  const invalidate = useInvalidateAfterMutation();
  return useMutation({
    mutationFn: api.createRequest,
    onSuccess: invalidate,
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
