import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { buildUrl } from "@shared/routes";
import type { MachineConfig, Setting } from "@shared/schema";

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export function useSettings() {
  return useQuery<Setting[]>({
    queryKey: ["/api/settings"],
    queryFn: () => fetchJson("/api/settings"),
  });
}

export function useSetting(key: string) {
  return useQuery<Setting>({
    queryKey: ["/api/settings", key],
    queryFn: () => fetchJson(`/api/settings/${key}`),
    retry: false,
  });
}

export function useMachineConfig() {
  const query = useSetting("machine_config");
  return {
    ...query,
    machineConfig: query.data?.value as MachineConfig | undefined,
  };
}

export function useUpdateSetting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ key, value }: { key: string; value: any }) => {
      return fetchJson(`/api/settings/${key}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/settings", variables.key] });
    },
  });
}
