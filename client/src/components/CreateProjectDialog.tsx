import { useState } from "react";
import { useCreateProject } from "@/hooks/use-projects";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Plus } from "lucide-react";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { insertProjectSchema } from "@shared/schema";

// Helper schema for the form (we only ask for basic info initially)
const createFormSchema = insertProjectSchema.pick({ name: true, description: true });
type CreateFormValues = z.infer<typeof createFormSchema>;

export function CreateProjectDialog() {
  const [open, setOpen] = useState(false);
  const { mutate, isPending } = useCreateProject();

  const form = useForm<CreateFormValues>({
    resolver: zodResolver(createFormSchema),
    defaultValues: { name: "", description: "" }
  });

  const onSubmit = (values: CreateFormValues) => {
    // Initialize with default stock and empty profile
    const defaultData = {
      stock: { diameter: 50, length: 100, zOffset: 0 },
      profile: [],
      operations: []
    };

    mutate(
      { ...values, data: defaultData },
      {
        onSuccess: () => {
          setOpen(false);
          form.reset();
        }
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/20 hover:shadow-primary/40 transition-all duration-300">
          <Plus className="w-4 h-4 mr-2" /> New Project
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-card border-border sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-xl font-bold font-mono">Create New Project</DialogTitle>
        </DialogHeader>
        
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 mt-4">
          <div className="space-y-2">
            <Label htmlFor="name" className="text-muted-foreground">Project Name</Label>
            <Input 
              id="name" 
              {...form.register("name")}
              placeholder="e.g. Chess Pawn" 
              className="bg-background border-input font-mono focus:ring-primary/20"
            />
            {form.formState.errors.name && (
              <span className="text-destructive text-sm">{form.formState.errors.name.message}</span>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="description" className="text-muted-foreground">Description</Label>
            <Textarea 
              id="description" 
              {...form.register("description")}
              placeholder="Material type, notes..." 
              className="bg-background border-input font-mono resize-none focus:ring-primary/20"
              rows={3}
            />
          </div>

          <div className="flex justify-end pt-4">
            <Button 
              type="submit" 
              disabled={isPending}
              className="w-full bg-primary hover:bg-primary/90 font-semibold"
            >
              {isPending ? "Creating..." : "Create Project"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
