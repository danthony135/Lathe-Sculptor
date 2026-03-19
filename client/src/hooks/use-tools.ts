import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, buildUrl } from "@shared/routes";
import type { ToolInput } from "@shared/routes";
import { useToast } from "@/hooks/use-toast";

export function useTools() {
  return useQuery({
    queryKey: [api.tools.list.path],
    queryFn: async () => {
      const res = await fetch(api.tools.list.path, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch tools");
      return api.tools.list.responses[200].parse(await res.json());
    },
  });
}

export function useCreateTool() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: ToolInput) => {
      const res = await fetch(api.tools.create.path, {
        method: api.tools.create.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to create tool");
      return api.tools.create.responses[201].parse(await res.json());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.tools.list.path] });
      toast({ title: "Tool Added", description: "New tool available in library." });
    },
    onError: (error: Error) => {
      toast({ variant: "destructive", title: "Error", description: error.message });
    },
  });
}

export function useUpdateTool() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<ToolInput> }) => {
      const url = buildUrl(api.tools.update.path, { id });
      const res = await fetch(url, {
        method: api.tools.update.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to update tool");
      return api.tools.update.responses[200].parse(await res.json());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.tools.list.path] });
      toast({ title: "Tool Updated", description: "Tool settings saved." });
    },
    onError: (error: Error) => {
      toast({ variant: "destructive", title: "Error", description: error.message });
    },
  });
}

export function useDeleteTool() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (id: number) => {
      const url = buildUrl(api.tools.delete.path, { id });
      const res = await fetch(url, { method: api.tools.delete.method, credentials: "include" });
      if (!res.ok) throw new Error("Failed to delete tool");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.tools.list.path] });
      toast({ title: "Tool Deleted", description: "Tool removed from library." });
    },
  });
}
