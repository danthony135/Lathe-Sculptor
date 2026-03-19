import { useState } from "react";
import { useCreateTool } from "@/hooks/use-tools";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus } from "lucide-react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { insertToolSchema } from "@shared/schema";
import type { ToolInput } from "@shared/routes";

const toolTypes = [
  { value: "turning", label: "Turning Tool (External)" },
  { value: "boring", label: "Boring Bar (Internal)" },
  { value: "grooving", label: "Grooving Tool" },
  { value: "parting", label: "Parting Tool" },
  { value: "drilling", label: "Drill Bit" },
  { value: "sanding", label: "Sanding Tool" },
  { value: "milling", label: "Milling Tool" },
  { value: "routing", label: "Router Bit" },
  { value: "planing", label: "Planer Blade" },
  { value: "v_bit", label: "V-Bit (Engraving)" },
  { value: "ball_nose", label: "Ball Nose End Mill" },
  { value: "threading", label: "Threading Tool" },
  { value: "custom", label: "Custom Type..." },
];

export function AddToolDialog() {
  const [open, setOpen] = useState(false);
  const [customType, setCustomType] = useState("");
  const [showCustomInput, setShowCustomInput] = useState(false);
  const { mutate, isPending } = useCreateTool();

  const form = useForm<ToolInput>({
    resolver: zodResolver(insertToolSchema),
    defaultValues: { 
      name: "", 
      type: "turning",
      toolNumber: 1,
      params: { tipRadius: 0.4, diameter: 10, description: "" } 
    }
  });

  const selectedType = form.watch("type");

  const onSubmit = (values: ToolInput) => {
    const finalValues = {
      ...values,
      type: showCustomInput && customType ? customType : values.type,
    };
    mutate(finalValues, {
      onSuccess: () => {
        setOpen(false);
        form.reset();
        setCustomType("");
        setShowCustomInput(false);
      }
    });
  };

  const handleTypeChange = (value: string) => {
    if (value === "custom") {
      setShowCustomInput(true);
      form.setValue("type", "custom");
    } else {
      setShowCustomInput(false);
      setCustomType("");
      form.setValue("type", value);
      
      // Set default params based on type
      switch (value) {
        case "turning":
        case "boring":
          form.setValue("params", { tipRadius: 0.4, diameter: 10, noseAngle: 55, cutDirection: "right", description: "" });
          break;
        case "grooving":
          form.setValue("params", { width: 3, diameter: 10, description: "" });
          break;
        case "parting":
          form.setValue("params", { cutWidth: 3, description: "" });
          break;
        case "drilling":
          form.setValue("params", { diameter: 10, pointAngle: 118, flutes: 2, description: "" });
          break;
        case "sanding":
          form.setValue("params", { grit: 120, width: 50, diameter: 80, description: "" });
          break;
        case "milling":
          form.setValue("params", { diameter: 60, flutes: 4, fluteLength: 30, toolHeight: 150, maxDepthOfCut: 5, description: "" });
          break;
        case "routing":
          form.setValue("params", { diameter: 6, flutes: 2, fluteLength: 15, description: "" });
          break;
        default:
          form.setValue("params", { description: "" });
      }
    }
  };

  const renderTypeSpecificFields = () => {
    const type = showCustomInput ? customType : selectedType;
    
    switch (type) {
      case "turning":
      case "boring":
        return (
          <>
            <div className="space-y-2">
              <Label>Tip Radius (mm)</Label>
              <Input 
                type="number" 
                step="0.1"
                className="font-mono"
                defaultValue={0.4}
                onChange={(e) => {
                  const currentParams = form.getValues("params") as any;
                  form.setValue("params", { ...currentParams, tipRadius: parseFloat(e.target.value) || 0.4 });
                }}
                data-testid="input-tip-radius"
              />
            </div>
            <div className="space-y-2">
              <Label>Diameter (mm)</Label>
              <Input 
                type="number" 
                className="font-mono"
                defaultValue={10}
                onChange={(e) => {
                  const currentParams = form.getValues("params") as any;
                  form.setValue("params", { ...currentParams, diameter: parseFloat(e.target.value) || 10 });
                }}
                data-testid="input-diameter"
              />
            </div>
            <div className="space-y-2">
              <Label>Nose Angle (°)</Label>
              <Input 
                type="number" 
                className="font-mono"
                defaultValue={55}
                onChange={(e) => {
                  const currentParams = form.getValues("params") as any;
                  form.setValue("params", { ...currentParams, noseAngle: parseFloat(e.target.value) || 55 });
                }}
                data-testid="input-nose-angle"
              />
            </div>
          </>
        );
      
      case "parting":
      case "grooving":
        return (
          <div className="space-y-2">
            <Label>Cut Width (mm)</Label>
            <Input 
              type="number" 
              step="0.5"
              className="font-mono"
              defaultValue={3}
              onChange={(e) => {
                const currentParams = form.getValues("params") as any;
                form.setValue("params", { ...currentParams, cutWidth: parseFloat(e.target.value) || 3 });
              }}
              data-testid="input-cut-width"
            />
          </div>
        );
      
      case "drilling":
        return (
          <>
            <div className="space-y-2">
              <Label>Diameter (mm)</Label>
              <Input 
                type="number" 
                className="font-mono"
                defaultValue={10}
                onChange={(e) => {
                  const currentParams = form.getValues("params") as any;
                  form.setValue("params", { ...currentParams, diameter: parseFloat(e.target.value) || 10 });
                }}
                data-testid="input-drill-diameter"
              />
            </div>
            <div className="space-y-2">
              <Label>Point Angle (°)</Label>
              <Input 
                type="number" 
                className="font-mono"
                defaultValue={118}
                onChange={(e) => {
                  const currentParams = form.getValues("params") as any;
                  form.setValue("params", { ...currentParams, pointAngle: parseFloat(e.target.value) || 118 });
                }}
                data-testid="input-point-angle"
              />
            </div>
            <div className="space-y-2">
              <Label>Number of Flutes</Label>
              <Input 
                type="number" 
                className="font-mono"
                defaultValue={2}
                onChange={(e) => {
                  const currentParams = form.getValues("params") as any;
                  form.setValue("params", { ...currentParams, flutes: parseInt(e.target.value) || 2 });
                }}
                data-testid="input-flutes"
              />
            </div>
          </>
        );
      
      case "sanding":
        return (
          <>
            <div className="space-y-2">
              <Label>Grit</Label>
              <Input 
                type="number" 
                className="font-mono"
                defaultValue={120}
                onChange={(e) => {
                  const currentParams = form.getValues("params") as any;
                  form.setValue("params", { ...currentParams, grit: parseInt(e.target.value) || 120 });
                }}
                data-testid="input-grit"
              />
            </div>
            <div className="space-y-2">
              <Label>Width (mm)</Label>
              <Input 
                type="number" 
                className="font-mono"
                defaultValue={50}
                onChange={(e) => {
                  const currentParams = form.getValues("params") as any;
                  form.setValue("params", { ...currentParams, width: parseFloat(e.target.value) || 50 });
                }}
                data-testid="input-sanding-width"
              />
            </div>
            <div className="space-y-2">
              <Label>Diameter (mm)</Label>
              <Input 
                type="number" 
                className="font-mono"
                defaultValue={80}
                onChange={(e) => {
                  const currentParams = form.getValues("params") as any;
                  form.setValue("params", { ...currentParams, diameter: parseFloat(e.target.value) || 80 });
                }}
                data-testid="input-sanding-diameter"
              />
            </div>
          </>
        );
      
      case "milling":
        return (
          <>
            <div className="space-y-2">
              <Label>Diameter (mm)</Label>
              <Input 
                type="number" 
                className="font-mono"
                defaultValue={60}
                onChange={(e) => {
                  const currentParams = form.getValues("params") as any;
                  form.setValue("params", { ...currentParams, diameter: parseFloat(e.target.value) || 60 });
                }}
                data-testid="input-mill-diameter"
              />
            </div>
            <div className="space-y-2">
              <Label>Tool Height (mm)</Label>
              <Input 
                type="number" 
                className="font-mono"
                defaultValue={150}
                onChange={(e) => {
                  const currentParams = form.getValues("params") as any;
                  form.setValue("params", { ...currentParams, toolHeight: parseFloat(e.target.value) || 150 });
                }}
                data-testid="input-tool-height"
              />
            </div>
            <div className="space-y-2">
              <Label>Number of Flutes</Label>
              <Input 
                type="number" 
                className="font-mono"
                defaultValue={4}
                onChange={(e) => {
                  const currentParams = form.getValues("params") as any;
                  form.setValue("params", { ...currentParams, flutes: parseInt(e.target.value) || 4 });
                }}
                data-testid="input-mill-flutes"
              />
            </div>
            <div className="space-y-2">
              <Label>Flute Length (mm)</Label>
              <Input 
                type="number" 
                className="font-mono"
                defaultValue={30}
                onChange={(e) => {
                  const currentParams = form.getValues("params") as any;
                  form.setValue("params", { ...currentParams, fluteLength: parseFloat(e.target.value) || 30 });
                }}
                data-testid="input-flute-length"
              />
            </div>
            <div className="space-y-2">
              <Label>Max Cut Depth (mm/pass)</Label>
              <Input 
                type="number" 
                step="0.5"
                className="font-mono"
                defaultValue={5}
                onChange={(e) => {
                  const currentParams = form.getValues("params") as any;
                  form.setValue("params", { ...currentParams, maxDepthOfCut: parseFloat(e.target.value) || 5 });
                }}
                data-testid="input-max-depth"
              />
            </div>
          </>
        );

      case "routing":
        return (
          <>
            <div className="space-y-2">
              <Label>Diameter (mm)</Label>
              <Input 
                type="number" 
                className="font-mono"
                defaultValue={6}
                onChange={(e) => {
                  const currentParams = form.getValues("params") as any;
                  form.setValue("params", { ...currentParams, diameter: parseFloat(e.target.value) || 6 });
                }}
                data-testid="input-router-diameter"
              />
            </div>
            <div className="space-y-2">
              <Label>Number of Flutes</Label>
              <Input 
                type="number" 
                className="font-mono"
                defaultValue={2}
                onChange={(e) => {
                  const currentParams = form.getValues("params") as any;
                  form.setValue("params", { ...currentParams, flutes: parseInt(e.target.value) || 2 });
                }}
                data-testid="input-router-flutes"
              />
            </div>
            <div className="space-y-2">
              <Label>Flute Length (mm)</Label>
              <Input 
                type="number" 
                className="font-mono"
                defaultValue={15}
                onChange={(e) => {
                  const currentParams = form.getValues("params") as any;
                  form.setValue("params", { ...currentParams, fluteLength: parseFloat(e.target.value) || 15 });
                }}
                data-testid="input-router-flute-length"
              />
            </div>
          </>
        );
      
      default:
        return (
          <div className="space-y-2">
            <Label>Diameter (mm)</Label>
            <Input 
              type="number" 
              className="font-mono"
              defaultValue={10}
              onChange={(e) => {
                const currentParams = form.getValues("params") as any;
                form.setValue("params", { ...currentParams, diameter: parseFloat(e.target.value) || 10 });
              }}
              data-testid="input-generic-diameter"
            />
          </div>
        );
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="bg-primary hover:bg-primary/90 text-primary-foreground" data-testid="button-add-tool">
          <Plus className="w-4 h-4 mr-2" /> Add Tool
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-card border-border max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono">Add New Tool</DialogTitle>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label>Tool Name</Label>
            <Input {...form.register("name")} className="font-mono" placeholder="T01 Roughing" data-testid="input-tool-name" />
          </div>

          <div className="space-y-2">
            <Label>Tool Number</Label>
            <Input 
              type="number" 
              {...form.register("toolNumber", { valueAsNumber: true })} 
              className="font-mono" 
              placeholder="1" 
              data-testid="input-tool-number" 
            />
          </div>

          <div className="space-y-2">
            <Label>Type</Label>
            <Controller
              control={form.control}
              name="type"
              render={({ field }) => (
                <Select onValueChange={handleTypeChange} defaultValue={field.value}>
                  <SelectTrigger className="font-mono" data-testid="select-tool-type">
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    {toolTypes.map(t => (
                      <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          {showCustomInput && (
            <div className="space-y-2">
              <Label>Custom Type Name</Label>
              <Input 
                value={customType}
                onChange={(e) => setCustomType(e.target.value)}
                className="font-mono" 
                placeholder="e.g., threading, chamfer" 
                data-testid="input-custom-type"
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            {renderTypeSpecificFields()}
          </div>

          <div className="space-y-2">
            <Label>Description (optional)</Label>
            <Input 
              className="font-mono"
              placeholder="Tool description..."
              onChange={(e) => {
                const currentParams = form.getValues("params") as any;
                form.setValue("params", { ...currentParams, description: e.target.value });
              }}
              data-testid="input-description"
            />
          </div>

          <Button type="submit" disabled={isPending} className="w-full mt-4" data-testid="button-submit-tool">
            {isPending ? "Adding..." : "Add Tool"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
