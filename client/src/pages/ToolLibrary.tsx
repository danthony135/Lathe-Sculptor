import { useState } from "react";
import { useTools, useDeleteTool, useUpdateTool } from "@/hooks/use-tools";
import { AddToolDialog } from "@/components/AddToolDialog";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Trash2, Disc, Cylinder, Pencil } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import type { Tool } from "@shared/schema";

const toolTypes = [
  { value: "turning", label: "Turning Tool" },
  { value: "boring", label: "Boring Bar" },
  { value: "grooving", label: "Grooving Tool" },
  { value: "parting", label: "Parting Tool" },
  { value: "drilling", label: "Drill Bit" },
  { value: "sanding", label: "Sanding Tool" },
  { value: "routing", label: "Router Tool" },
  { value: "milling", label: "Milling Tool" },
];

const ToolIcon = ({ type }: { type: string }) => {
  switch (type) {
    case 'turning': return <Cylinder className="w-8 h-8 text-primary" />;
    case 'grooving': return <Disc className="w-8 h-8 text-accent" />;
    default: return <Cylinder className="w-8 h-8 text-muted-foreground" />;
  }
};

function EditToolDialog({ 
  tool, 
  open, 
  onOpenChange 
}: { 
  tool: Tool; 
  open: boolean; 
  onOpenChange: (open: boolean) => void;
}) {
  const updateTool = useUpdateTool();
  const params = tool.params as Record<string, any>;
  
  const [name, setName] = useState(tool.name);
  const [type, setType] = useState(tool.type);
  const [toolNumber, setToolNumber] = useState(tool.toolNumber);
  const [tipRadius, setTipRadius] = useState(params.tipRadius ?? 0.4);
  const [diameter, setDiameter] = useState(params.diameter ?? 10);
  const [width, setWidth] = useState(params.width ?? 0);
  const [noseAngle, setNoseAngle] = useState(params.noseAngle ?? 55);
  const [toolHeight, setToolHeight] = useState(params.toolHeight ?? 150);
  const [fluteLength, setFluteLength] = useState(params.fluteLength ?? 30);
  const [maxDepthOfCut, setMaxDepthOfCut] = useState(params.maxDepthOfCut ?? 5);
  const [flutes, setFlutes] = useState(params.flutes ?? 4);

  const handleSave = () => {
    updateTool.mutate({
      id: tool.id,
      data: {
        name,
        type,
        toolNumber,
        params: {
          ...params,
          tipRadius,
          diameter,
          width,
          noseAngle,
          toolHeight,
          fluteLength,
          maxDepthOfCut,
          flutes,
        },
      },
    }, {
      onSuccess: () => onOpenChange(false),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-border">
        <DialogHeader>
          <DialogTitle className="font-mono">Edit Tool</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Tool Number</Label>
              <Input
                type="number"
                value={toolNumber}
                onChange={(e) => setToolNumber(parseInt(e.target.value) || 1)}
                className="font-mono"
                data-testid="input-edit-tool-number"
              />
            </div>
            <div className="space-y-2">
              <Label>Type</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger className="font-mono" data-testid="select-edit-tool-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {toolTypes.map(t => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Tool Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="font-mono"
              data-testid="input-edit-tool-name"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            {(type === 'turning' || type === 'boring') && (
              <>
                <div className="space-y-2">
                  <Label>Tip Radius (mm)</Label>
                  <Input
                    type="number"
                    step="0.1"
                    value={tipRadius}
                    onChange={(e) => setTipRadius(parseFloat(e.target.value) || 0)}
                    className="font-mono"
                    data-testid="input-edit-tip-radius"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Nose Angle (deg)</Label>
                  <Input
                    type="number"
                    value={noseAngle}
                    onChange={(e) => setNoseAngle(parseFloat(e.target.value) || 0)}
                    className="font-mono"
                    data-testid="input-edit-nose-angle"
                  />
                </div>
              </>
            )}
            {(type === 'drilling' || type === 'routing' || type === 'milling' || type === 'sanding') && (
              <div className="space-y-2">
                <Label>Diameter (mm)</Label>
                <Input
                  type="number"
                  step="0.1"
                  value={diameter}
                  onChange={(e) => setDiameter(parseFloat(e.target.value) || 0)}
                  className="font-mono"
                  data-testid="input-edit-diameter"
                />
              </div>
            )}
            {type === 'milling' && (
              <>
                <div className="space-y-2">
                  <Label>Tool Height (mm)</Label>
                  <Input
                    type="number"
                    step="1"
                    value={toolHeight}
                    onChange={(e) => setToolHeight(parseFloat(e.target.value) || 150)}
                    className="font-mono"
                    data-testid="input-edit-tool-height"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Flute Length (mm)</Label>
                  <Input
                    type="number"
                    step="1"
                    value={fluteLength}
                    onChange={(e) => setFluteLength(parseFloat(e.target.value) || 30)}
                    className="font-mono"
                    data-testid="input-edit-flute-length"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Max Cut Depth (mm/pass)</Label>
                  <Input
                    type="number"
                    step="0.5"
                    value={maxDepthOfCut}
                    onChange={(e) => setMaxDepthOfCut(parseFloat(e.target.value) || 5)}
                    className="font-mono"
                    data-testid="input-edit-max-depth"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Number of Flutes</Label>
                  <Input
                    type="number"
                    value={flutes}
                    onChange={(e) => setFlutes(parseInt(e.target.value) || 4)}
                    className="font-mono"
                    data-testid="input-edit-flutes"
                  />
                </div>
              </>
            )}
            {(type === 'grooving' || type === 'parting' || type === 'sanding') && (
              <div className="space-y-2">
                <Label>Width (mm)</Label>
                <Input
                  type="number"
                  step="0.1"
                  value={width}
                  onChange={(e) => setWidth(parseFloat(e.target.value) || 0)}
                  className="font-mono"
                  data-testid="input-edit-width"
                />
              </div>
            )}
          </div>

          <Button 
            onClick={handleSave} 
            disabled={updateTool.isPending} 
            className="w-full mt-4"
            data-testid="button-save-tool"
          >
            {updateTool.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function ToolLibrary() {
  const { data: tools, isLoading } = useTools();
  const deleteTool = useDeleteTool();
  const [editingTool, setEditingTool] = useState<Tool | null>(null);

  return (
    <div className="container mx-auto p-4 md:p-8 space-y-8 max-w-7xl">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold font-mono tracking-tight">TOOL LIBRARY</h1>
          <p className="text-muted-foreground mt-1">Manage your lathe tooling inventory.</p>
        </div>
        <AddToolDialog />
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {[1,2,3,4].map(i => <Skeleton key={i} className="h-40 bg-card" />)}
        </div>
      ) : tools?.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground bg-card/10 rounded-xl border border-dashed border-border">
          No tools defined yet. Add standard tools to get started.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {tools?.map((tool) => {
            const params = tool.params as any;
            return (
              <Card key={tool.id} className="bg-card border-border hover:border-primary/50 transition-colors">
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                  <Badge variant="outline" className="font-mono text-xs uppercase bg-background">
                    T{tool.toolNumber.toString().padStart(2, '0')} - {tool.type}
                  </Badge>
                  <div className="flex gap-1">
                    <Button 
                      variant="ghost" 
                      size="icon"
                      onClick={() => setEditingTool(tool)}
                      data-testid={`button-edit-tool-${tool.id}`}
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button 
                      variant="ghost" 
                      size="icon"
                      onClick={() => {
                        if (confirm("Delete this tool?")) {
                          deleteTool.mutate(tool.id);
                        }
                      }}
                      data-testid={`button-delete-tool-${tool.id}`}
                    >
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="pt-4 flex flex-col items-center text-center">
                  <div className="mb-4 p-3 bg-background rounded-full border border-border shadow-inner">
                    <ToolIcon type={tool.type} />
                  </div>
                  <h3 className="font-bold text-lg">{tool.name}</h3>
                  <div className="mt-4 grid grid-cols-2 gap-x-8 gap-y-2 text-sm text-muted-foreground">
                    {params.tipRadius !== undefined && (
                      <>
                        <span>Radius:</span>
                        <span className="font-mono text-foreground">{params.tipRadius}mm</span>
                      </>
                    )}
                    {params.diameter !== undefined && (
                      <>
                        <span>Diameter:</span>
                        <span className="font-mono text-foreground">{params.diameter}mm</span>
                      </>
                    )}
                    {params.width !== undefined && params.width > 0 && (
                      <>
                        <span>Width:</span>
                        <span className="font-mono text-foreground">{params.width}mm</span>
                      </>
                    )}
                    {params.noseAngle !== undefined && (
                      <>
                        <span>Nose Angle:</span>
                        <span className="font-mono text-foreground">{params.noseAngle}°</span>
                      </>
                    )}
                    {params.toolHeight !== undefined && (
                      <>
                        <span>Height:</span>
                        <span className="font-mono text-foreground">{params.toolHeight}mm</span>
                      </>
                    )}
                    {params.fluteLength !== undefined && (
                      <>
                        <span>Flute Length:</span>
                        <span className="font-mono text-foreground">{params.fluteLength}mm</span>
                      </>
                    )}
                    {params.maxDepthOfCut !== undefined && (
                      <>
                        <span>Max Cut:</span>
                        <span className="font-mono text-foreground">{params.maxDepthOfCut}mm</span>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {editingTool && (
        <EditToolDialog 
          tool={editingTool} 
          open={!!editingTool} 
          onOpenChange={(open) => !open && setEditingTool(null)} 
        />
      )}
    </div>
  );
}
