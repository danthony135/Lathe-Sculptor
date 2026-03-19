import { useEffect, useState } from "react";
import { useParams, Link } from "wouter";
import { useProject, useUpdateProject, useGenerateGCode } from "@/hooks/use-projects";
import { useTools } from "@/hooks/use-tools";
import { ThreeCanvas } from "@/components/ThreeCanvas";
import { FileImporter } from "@/components/FileImporter";
import { geometryToToolpath } from "@/lib/dxf-parser";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { 
  ChevronLeft, Play, Pause, Save, BoxSelect, 
  Upload, Download, Copy, RotateCcw, AlertTriangle,
  Wrench, Settings2, Trash2, ChevronDown, ChevronUp, GripVertical
} from "lucide-react";
import type { ProjectData, ToolpathPoint, Operation, OperationType, ImportedGeometry, Tool } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";

const DEFAULT_PROJECT_DATA: ProjectData = {
  stock: { type: 'square', diameter: 50, width: 50, height: 50, length: 200, zOffset: 0, material: 'oak' },
  toolpath: [],
  operations: [],
  machineSettings: {
    safeZ: 50,
    safeX: 150,
    homeA: 0,
    rapidFeed: 5000,
    workFeed: 3000,
  },
  quantity: 1,  // Number of pieces to cut
};

export default function ProjectEditor() {
  const { id } = useParams<{ id: string }>();
  const projectId = Number(id);
  const { data: project, isLoading } = useProject(projectId);
  const updateProject = useUpdateProject();
  const generateGCode = useGenerateGCode();
  const { data: tools } = useTools();
  const { toast } = useToast();

  const [localData, setLocalData] = useState<ProjectData | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [showImporter, setShowImporter] = useState(false);
  const [isSimulating, setIsSimulating] = useState(false);
  const [simulationProgress, setSimulationProgress] = useState(0);
  const [selectedToolNumber, setSelectedToolNumber] = useState<number>(1);
  const [collisionWarnings, setCollisionWarnings] = useState<string[]>([]);
  const [expandedOps, setExpandedOps] = useState<Set<string>>(new Set());
  const [draggedOpId, setDraggedOpId] = useState<string | null>(null);

  useEffect(() => {
    if (project?.data) {
      const data = project.data as unknown as ProjectData;
      setLocalData({
        stock: { ...DEFAULT_PROJECT_DATA.stock, ...data.stock },
        machineSettings: { ...DEFAULT_PROJECT_DATA.machineSettings, ...data.machineSettings },
        toolpath: data.toolpath || [],
        operations: data.operations || [],
        geometry: data.geometry,
        quantity: data.quantity || 1,
      });
    }
  }, [project]);

  useEffect(() => {
    if (localData?.toolpath && localData.toolpath.length > 0) {
      const warnings = checkCollisions(localData);
      setCollisionWarnings(warnings);
    }
  }, [localData?.toolpath]);

  if (isLoading || !localData) {
    return (
      <div className="h-screen flex items-center justify-center text-muted-foreground">
        Loading Editor...
      </div>
    );
  }
  
  if (!project) {
    return (
      <div className="h-screen flex items-center justify-center text-destructive">
        Project not found
      </div>
    );
  }

  const handleSave = async () => {
    return new Promise<void>((resolve, reject) => {
      updateProject.mutate(
        { id: projectId, data: { name: project.name, description: project.description, data: localData } },
        {
          onSuccess: () => {
            setHasUnsavedChanges(false);
            resolve();
          },
          onError: (error) => {
            toast({ variant: "destructive", title: "Save failed", description: error.message });
            reject(error);
          },
        }
      );
    });
  };

  const handleGenerate = async () => {
    try {
      if (hasUnsavedChanges) {
        await handleSave();
      }
      generateGCode.mutate(projectId);
    } catch (error) {
      // Save failed, don't generate
    }
  };

  const handleImport = (geometry: ImportedGeometry, recommendedStock?: { diameter: number; length: number }) => {
    // Use recommended stock dimensions if provided, otherwise keep current
    const stockDiameter = recommendedStock?.diameter ?? localData.stock.diameter;
    const stockLength = recommendedStock?.length ?? localData.stock.length;
    
    const toolpath = geometryToToolpath(
      geometry,
      stockDiameter,
      0,    // rotationStart
      0,    // rotationEnd (0 for standard 2-axis turning)
      1     // rotationSteps (1 for 2-axis turning, >1 for 4-axis)
    );
    
    setLocalData(prev => prev ? ({
      ...prev,
      geometry,
      stock: {
        ...prev.stock,
        diameter: stockDiameter,
        length: stockLength,
      },
      toolpath: toolpath.map((p, i) => ({ ...p, feedRate: prev.machineSettings.workFeed })),
    }) : null);
    
    setShowImporter(false);
    setHasUnsavedChanges(true);
    
    const stockInfo = recommendedStock 
      ? ` Stock auto-sized to ${stockDiameter}mm x ${stockLength}mm.`
      : '';
    
    toast({
      title: "Geometry imported",
      description: `Generated ${toolpath.length} toolpath points from ${geometry.sourceFile}.${stockInfo}`,
    });
  };

  const updateStock = (field: keyof typeof localData.stock, value: number | string) => {
    setLocalData(prev => prev ? ({
      ...prev,
      stock: { ...prev.stock, [field]: value }
    }) : null);
    setHasUnsavedChanges(true);
  };

  const updateMachineSettings = (field: keyof typeof localData.machineSettings, value: number) => {
    setLocalData(prev => prev ? ({
      ...prev,
      machineSettings: { ...prev.machineSettings, [field]: value }
    }) : null);
    setHasUnsavedChanges(true);
  };

  const updateQuantity = (value: number) => {
    setLocalData(prev => prev ? ({
      ...prev,
      quantity: Math.max(1, value)  // Minimum 1 piece
    }) : null);
    setHasUnsavedChanges(true);
  };

  const addOperation = () => {
    const selectedTool = tools?.find(t => t.toolNumber === selectedToolNumber);
    const newOp: Operation = {
      id: Math.random().toString(36).substr(2, 9),
      toolNumber: selectedToolNumber,
      type: (selectedTool?.type as any) || 'roughing',
      params: {
        feedRate: 200,           // Default cutting feed rate mm/min
        rapidFeedRate: localData.machineSettings.rapidFeed,
        spindleSpeed: 2100,      // Default spindle speed RPM
        depthOfCut: 2,
      },
    };
    
    setLocalData(prev => prev ? ({
      ...prev,
      operations: [...prev.operations, newOp],
    }) : null);
    setHasUnsavedChanges(true);
  };

  const deleteOperation = (opId: string) => {
    setLocalData(prev => prev ? ({
      ...prev,
      operations: prev.operations.filter(op => op.id !== opId),
    }) : null);
    setHasUnsavedChanges(true);
    toast({ title: "Operation deleted" });
  };

  const reorderOperations = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    setLocalData(prev => {
      if (!prev) return null;
      const ops = [...prev.operations];
      const [movedOp] = ops.splice(fromIndex, 1);
      ops.splice(toIndex, 0, movedOp);
      return { ...prev, operations: ops };
    });
    setHasUnsavedChanges(true);
  };

  const handleDragStart = (e: React.DragEvent, opId: string) => {
    setDraggedOpId(opId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', opId);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e: React.DragEvent, targetOpId: string) => {
    e.preventDefault();
    if (!draggedOpId || draggedOpId === targetOpId || !localData) return;
    
    const fromIndex = localData.operations.findIndex(op => op.id === draggedOpId);
    const toIndex = localData.operations.findIndex(op => op.id === targetOpId);
    
    if (fromIndex !== -1 && toIndex !== -1) {
      reorderOperations(fromIndex, toIndex);
    }
    setDraggedOpId(null);
  };

  const handleDragEnd = () => {
    setDraggedOpId(null);
  };

  const updateOperation = (opId: string, field: keyof Operation['params'], value: number) => {
    setLocalData(prev => prev ? ({
      ...prev,
      operations: prev.operations.map(op => 
        op.id === opId 
          ? { ...op, params: { ...op.params, [field]: value } }
          : op
      ),
    }) : null);
    setHasUnsavedChanges(true);
  };

  const updateOperationRotationMode = (opId: string, mode: Operation['rotationMode']) => {
    setLocalData(prev => prev ? ({
      ...prev,
      operations: prev.operations.map(op => 
        op.id === opId 
          ? { ...op, rotationMode: mode }
          : op
      ),
    }) : null);
    setHasUnsavedChanges(true);
  };

  const updateOperationType = (opId: string, type: Operation['type']) => {
    setLocalData(prev => prev ? ({
      ...prev,
      operations: prev.operations.map(op =>
        op.id === opId
          ? {
              ...op,
              type,
              // Set sensible defaults based on operation type
              rotationMode: type === 'turning' || type === 'sanding' || type === 'roughing' || type === 'finishing'
                ? 'continuous'
                : type === 'milling' || type === 'routing' || type === 'planing'
                  ? 'indexed'
                  : type === 'drilling' || type === 'engraving'
                    ? 'static'
                    : type === 'carving_3d' || type === 'contouring_4axis'
                      ? 'simultaneous'
                      : type === 'threading' || type === 'grooving'
                        ? 'continuous'
                        : op.rotationMode
            }
          : op
      ),
    }) : null);
    setHasUnsavedChanges(true);
  };

  const toggleOpExpanded = (opId: string) => {
    setExpandedOps(prev => {
      const next = new Set(prev);
      if (next.has(opId)) {
        next.delete(opId);
      } else {
        next.add(opId);
      }
      return next;
    });
  };

  const toggleSimulation = () => {
    if (isSimulating) {
      setIsSimulating(false);
    } else {
      setSimulationProgress(0);
      setIsSimulating(true);
    }
  };

  const resetSimulation = () => {
    setIsSimulating(false);
    setSimulationProgress(0);
  };

  const handleDownloadGCode = () => {
    if (!project.gcode) return;
    const blob = new Blob([project.gcode], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project.name.replace(/\s+/g, '_')}.nc`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopyGCode = () => {
    if (!project.gcode) return;
    navigator.clipboard.writeText(project.gcode);
    toast({ title: "G-code copied to clipboard" });
  };

  const currentTool = tools?.find(t => t.toolNumber === selectedToolNumber);

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      <header className="h-14 border-b border-border bg-card flex items-center justify-between gap-4 px-4 shrink-0">
        <div className="flex items-center gap-4 flex-wrap">
          <Link href="/">
            <Button variant="ghost" size="sm" className="gap-2" data-testid="button-back">
              <ChevronLeft className="w-4 h-4" /> Back
            </Button>
          </Link>
          <div className="h-6 w-px bg-border" />
          <h1 className="font-mono font-bold text-lg text-primary truncate" data-testid="text-project-name">
            {project.name}
          </h1>
          <Badge variant={hasUnsavedChanges ? "destructive" : "secondary"} className="shrink-0">
            {hasUnsavedChanges ? "Unsaved" : "Saved"}
          </Badge>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Button 
            variant="outline" 
            size="sm" 
            onClick={() => setShowImporter(true)}
            data-testid="button-import"
          >
            <Upload className="w-4 h-4 mr-2" /> Import CAD
          </Button>
          <Button 
            variant="outline" 
            size="sm" 
            onClick={handleSave}
            disabled={!hasUnsavedChanges || updateProject.isPending}
            data-testid="button-save"
          >
            <Save className="w-4 h-4 mr-2" /> Save
          </Button>
          <Button 
            size="sm" 
            onClick={handleGenerate}
            disabled={generateGCode.isPending || localData.toolpath.length === 0}
            data-testid="button-generate"
          >
            <Play className="w-4 h-4 mr-2" /> Generate G-Code
          </Button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        <aside className="w-80 border-r border-border bg-card/50 flex flex-col shrink-0">
          <Tabs defaultValue="setup" className="flex-1 flex flex-col">
            <TabsList className="grid grid-cols-3 bg-muted/50 p-1 m-2">
              <TabsTrigger value="setup" data-testid="tab-setup">Setup</TabsTrigger>
              <TabsTrigger value="tools" data-testid="tab-tools">Tools</TabsTrigger>
              <TabsTrigger value="ops" data-testid="tab-operations">Ops</TabsTrigger>
            </TabsList>

            <ScrollArea className="flex-1">
              <TabsContent value="setup" className="p-4 space-y-6 mt-0">
                <div className="space-y-4">
                  <h3 className="font-mono text-sm font-bold text-muted-foreground uppercase flex items-center gap-2">
                    <BoxSelect className="w-4 h-4" /> Stock Material
                  </h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5 col-span-2">
                      <Label className="text-xs">Stock Shape</Label>
                      <Select 
                        value={localData.stock.type || 'square'} 
                        onValueChange={(v) => updateStock('type', v)}
                      >
                        <SelectTrigger data-testid="select-stock-type">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="square">Square / Rectangular</SelectItem>
                          <SelectItem value="round">Round (Cylinder)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    
                    {(localData.stock.type || 'square') === 'round' ? (
                      <div className="space-y-1.5">
                        <Label className="text-xs">Diameter (mm)</Label>
                        <Input 
                          type="number" 
                          value={localData.stock.diameter} 
                          onChange={(e) => updateStock('diameter', parseFloat(e.target.value) || 0)}
                          className="font-mono text-right"
                          data-testid="input-stock-diameter"
                        />
                      </div>
                    ) : (
                      <>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Width (mm)</Label>
                          <Input 
                            type="number" 
                            value={localData.stock.width || localData.stock.diameter} 
                            onChange={(e) => {
                              const val = parseFloat(e.target.value) || 0;
                              updateStock('width', val);
                              // Update diameter to max of width/height for compatibility
                              const maxDim = Math.max(val, localData.stock.height || localData.stock.diameter);
                              updateStock('diameter', maxDim);
                            }}
                            className="font-mono text-right"
                            data-testid="input-stock-width"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Height (mm)</Label>
                          <Input 
                            type="number" 
                            value={localData.stock.height || localData.stock.diameter} 
                            onChange={(e) => {
                              const val = parseFloat(e.target.value) || 0;
                              updateStock('height', val);
                              // Update diameter to max of width/height for compatibility
                              const maxDim = Math.max(localData.stock.width || localData.stock.diameter, val);
                              updateStock('diameter', maxDim);
                            }}
                            className="font-mono text-right"
                            data-testid="input-stock-height"
                          />
                        </div>
                      </>
                    )}
                    
                    <div className="space-y-1.5">
                      <Label className="text-xs">Length (mm)</Label>
                      <Input 
                        type="number" 
                        value={localData.stock.length} 
                        onChange={(e) => updateStock('length', parseFloat(e.target.value) || 0)}
                        className="font-mono text-right"
                        data-testid="input-stock-length"
                      />
                    </div>
                    <div className="space-y-1.5 col-span-2">
                      <Label className="text-xs">Material Type</Label>
                      <Select 
                        value={localData.stock.material || 'oak'} 
                        onValueChange={(v) => updateStock('material', v)}
                      >
                        <SelectTrigger data-testid="select-material">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="oak">Oak</SelectItem>
                          <SelectItem value="maple">Maple</SelectItem>
                          <SelectItem value="walnut">Walnut</SelectItem>
                          <SelectItem value="pine">Pine</SelectItem>
                          <SelectItem value="cherry">Cherry</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>

                <Separator />

                <div className="space-y-4">
                  <h3 className="font-mono text-sm font-bold text-muted-foreground uppercase flex items-center gap-2">
                    <Settings2 className="w-4 h-4" /> Machine Settings
                  </h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Rapid Feed (mm/min)</Label>
                      <Input 
                        type="number" 
                        value={localData.machineSettings.rapidFeed} 
                        onChange={(e) => updateMachineSettings('rapidFeed', parseFloat(e.target.value) || 0)}
                        className="font-mono text-right"
                        data-testid="input-rapid-feed"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Work Feed (mm/min)</Label>
                      <Input 
                        type="number" 
                        value={localData.machineSettings.workFeed} 
                        onChange={(e) => updateMachineSettings('workFeed', parseFloat(e.target.value) || 0)}
                        className="font-mono text-right"
                        data-testid="input-work-feed"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Safe Z (mm)</Label>
                      <Input 
                        type="number" 
                        value={localData.machineSettings.safeZ} 
                        onChange={(e) => updateMachineSettings('safeZ', parseFloat(e.target.value) || 0)}
                        className="font-mono text-right"
                        data-testid="input-safe-z"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Safe X (mm)</Label>
                      <Input 
                        type="number" 
                        value={localData.machineSettings.safeX} 
                        onChange={(e) => updateMachineSettings('safeX', parseFloat(e.target.value) || 0)}
                        className="font-mono text-right"
                        data-testid="input-safe-x"
                      />
                    </div>
                    <div className="space-y-1.5 col-span-2">
                      <Label className="text-xs">Quantity (pieces to cut)</Label>
                      <Input 
                        type="number" 
                        min={1}
                        value={localData.quantity || 1} 
                        onChange={(e) => updateQuantity(parseInt(e.target.value) || 1)}
                        className="font-mono text-right"
                        data-testid="input-quantity"
                      />
                    </div>
                  </div>
                </div>

                {localData.geometry && (
                  <>
                    <Separator />
                    <div className="space-y-2">
                      <h3 className="font-mono text-sm font-bold text-muted-foreground uppercase">Imported Geometry</h3>
                      <div className="p-3 bg-muted/30 rounded border border-border text-sm">
                        <p className="font-mono truncate">{localData.geometry.sourceFile}</p>
                        <p className="text-muted-foreground text-xs mt-1">
                          {localData.geometry.vertices.length} vertices
                        </p>
                      </div>
                    </div>
                  </>
                )}
              </TabsContent>

              <TabsContent value="tools" className="p-4 space-y-4 mt-0">
                <div className="space-y-4">
                  <h3 className="font-mono text-sm font-bold text-muted-foreground uppercase flex items-center gap-2">
                    <Wrench className="w-4 h-4" /> Catek 7-in-1 Tools
                  </h3>
                  
                  {tools?.map((tool) => (
                    <div 
                      key={tool.id}
                      className={`p-3 rounded border cursor-pointer transition-colors ${
                        selectedToolNumber === tool.toolNumber 
                          ? 'border-primary bg-primary/10' 
                          : 'border-border hover:border-primary/50'
                      }`}
                      onClick={() => setSelectedToolNumber(tool.toolNumber)}
                      data-testid={`tool-card-${tool.toolNumber}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="font-mono">T{tool.toolNumber.toString().padStart(2, '0')}</Badge>
                          <span className="font-medium text-sm truncate">{tool.name}</span>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 capitalize">{tool.type}</p>
                    </div>
                  ))}
                </div>
              </TabsContent>

              <TabsContent value="ops" className="p-4 space-y-4 mt-0">
                <Button 
                  variant="outline" 
                  className="w-full border-dashed"
                  onClick={addOperation}
                  disabled={!selectedToolNumber}
                  data-testid="button-add-operation"
                >
                  + Add Operation with T{selectedToolNumber.toString().padStart(2, '0')}
                </Button>
                
                {localData.operations.length === 0 ? (
                  <div className="text-center text-sm text-muted-foreground py-8">
                    Select a tool and add an operation
                  </div>
                ) : (
                  <div 
                    className="space-y-2"
                    onDragEnd={handleDragEnd}
                    onDragLeave={(e) => {
                      // Clear drag state if leaving the container entirely
                      if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                        setDraggedOpId(null);
                      }
                    }}
                  >
                    {localData.operations.map((op, idx) => {
                      const isExpanded = expandedOps.has(op.id);
                      const isDragging = draggedOpId === op.id;
                      return (
                        <div 
                          key={op.id} 
                          className={`bg-muted/30 rounded border transition-all ${
                            isDragging ? 'opacity-50 border-primary' : 'border-border'
                          }`}
                          onDragOver={handleDragOver}
                          onDrop={(e) => handleDrop(e, op.id)}
                          data-testid={`operation-item-${op.id}`}
                        >
                          <div 
                            className="p-3 cursor-pointer hover-elevate"
                            onClick={() => toggleOpExpanded(op.id)}
                            data-testid={`operation-header-${op.id}`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2">
                                <div 
                                  className="cursor-grab active:cursor-grabbing p-1 -ml-1 text-muted-foreground hover:text-foreground"
                                  draggable
                                  onDragStart={(e) => handleDragStart(e, op.id)}
                                  onDragEnd={handleDragEnd}
                                  onClick={(e) => e.stopPropagation()}
                                  data-testid={`drag-handle-${op.id}`}
                                >
                                  <GripVertical className="w-4 h-4" />
                                </div>
                                <Badge variant="secondary" className="font-mono">
                                  {idx + 1}. T{op.toolNumber.toString().padStart(2, '0')}
                                </Badge>
                                <span className="text-sm capitalize">{op.type}</span>
                              </div>
                              <div className="flex items-center gap-1">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    deleteOperation(op.id);
                                  }}
                                  data-testid={`button-delete-operation-${op.id}`}
                                >
                                  <Trash2 className="w-4 h-4 text-destructive" />
                                </Button>
                                {isExpanded ? (
                                  <ChevronUp className="w-4 h-4 text-muted-foreground" />
                                ) : (
                                  <ChevronDown className="w-4 h-4 text-muted-foreground" />
                                )}
                              </div>
                            </div>
                            <p className="text-xs text-muted-foreground mt-1">
                              F{op.params.feedRate} / S{op.params.spindleSpeed}
                            </p>
                          </div>
                          
                          {isExpanded && (
                            <div className="px-3 pb-3 space-y-3 border-t border-border pt-3">
                              <div className="space-y-1">
                                <Label className="text-xs">Operation Type</Label>
                                <Select
                                  value={op.type}
                                  onValueChange={(v) => updateOperationType(op.id, v as Operation['type'])}
                                >
                                  <SelectTrigger className="text-xs" data-testid={`select-operation-type-${op.id}`}>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="roughing">Roughing</SelectItem>
                                    <SelectItem value="turning">Turning (profile)</SelectItem>
                                    <SelectItem value="finishing">Finishing</SelectItem>
                                    <SelectItem value="sanding">Sanding</SelectItem>
                                    <SelectItem value="milling">Milling</SelectItem>
                                    <SelectItem value="drilling">Drilling</SelectItem>
                                    <SelectItem value="grooving">Grooving</SelectItem>
                                    <SelectItem value="threading">Threading</SelectItem>
                                    <SelectItem value="planing">Planing</SelectItem>
                                    <SelectItem value="engraving">Engraving</SelectItem>
                                    <SelectItem value="routing">Routing</SelectItem>
                                    <SelectItem value="carving_3d">3D Carving</SelectItem>
                                    <SelectItem value="contouring_4axis">4-Axis Contouring</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>

                              <div className="space-y-1">
                                <Label className="text-xs">Rotation Mode (A-axis)</Label>
                                <Select
                                  value={op.rotationMode || 'continuous'}
                                  onValueChange={(v) => updateOperationRotationMode(op.id, v as Operation['rotationMode'])}
                                >
                                  <SelectTrigger className="text-xs" data-testid={`select-rotation-mode-${op.id}`}>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="continuous">Continuous (turning/lathe)</SelectItem>
                                    <SelectItem value="indexed">Indexed (rotate, stop, mill)</SelectItem>
                                    <SelectItem value="static">Static (no rotation)</SelectItem>
                                    <SelectItem value="simultaneous">Simultaneous (4-axis)</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>

                              {op.rotationMode === 'indexed' && (
                                <div className="grid grid-cols-2 gap-3">
                                  <div className="space-y-1">
                                    <Label className="text-xs">Index Count</Label>
                                    <Input
                                      type="number"
                                      value={op.params.indexCount || 4}
                                      onChange={(e) => updateOperation(op.id, 'indexCount', parseInt(e.target.value) || 4)}
                                      className="font-mono text-right"
                                      data-testid={`input-index-count-${op.id}`}
                                    />
                                  </div>
                                  <div className="space-y-1">
                                    <Label className="text-xs">Index Angle (°)</Label>
                                    <Input
                                      type="number"
                                      value={op.params.indexAngle || 90}
                                      onChange={(e) => updateOperation(op.id, 'indexAngle', parseFloat(e.target.value) || 90)}
                                      className="font-mono text-right"
                                      data-testid={`input-index-angle-${op.id}`}
                                    />
                                  </div>
                                </div>
                              )}

                              {/* Drilling-specific params */}
                              {op.type === 'drilling' && (
                                <div className="grid grid-cols-2 gap-3">
                                  <div className="space-y-1">
                                    <Label className="text-xs">Hole Depth (mm)</Label>
                                    <Input type="number" value={op.params.drilling?.holeDepth || 10}
                                      onChange={e => {
                                        setLocalData(prev => prev ? ({ ...prev, operations: prev.operations.map(o => o.id === op.id ? { ...o, params: { ...o.params, drilling: { ...o.params.drilling, holeDepth: parseFloat(e.target.value) || 10, peckDepth: o.params.drilling?.peckDepth || 3, retractHeight: o.params.drilling?.retractHeight || 2, drillCycle: o.params.drilling?.drillCycle || 'peck', throughHole: o.params.drilling?.throughHole || false } } } : o) }) : null);
                                        setHasUnsavedChanges(true);
                                      }} className="font-mono text-right" />
                                  </div>
                                  <div className="space-y-1">
                                    <Label className="text-xs">Peck Depth (mm)</Label>
                                    <Input type="number" value={op.params.drilling?.peckDepth || 3}
                                      onChange={e => {
                                        setLocalData(prev => prev ? ({ ...prev, operations: prev.operations.map(o => o.id === op.id ? { ...o, params: { ...o.params, drilling: { ...o.params.drilling!, peckDepth: parseFloat(e.target.value) || 3 } } } : o) }) : null);
                                        setHasUnsavedChanges(true);
                                      }} className="font-mono text-right" />
                                  </div>
                                  <div className="space-y-1 col-span-2">
                                    <Label className="text-xs">Drill Cycle</Label>
                                    <Select value={op.params.drilling?.drillCycle || 'peck'}
                                      onValueChange={v => {
                                        setLocalData(prev => prev ? ({ ...prev, operations: prev.operations.map(o => o.id === op.id ? { ...o, params: { ...o.params, drilling: { ...o.params.drilling!, drillCycle: v as any } } } : o) }) : null);
                                        setHasUnsavedChanges(true);
                                      }}>
                                      <SelectTrigger className="text-xs"><SelectValue /></SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="spot">Spot Drill (G81)</SelectItem>
                                        <SelectItem value="peck">Peck Drill (G83)</SelectItem>
                                        <SelectItem value="deep_peck">Deep Peck (G83)</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                </div>
                              )}

                              {/* Grooving-specific params */}
                              {op.type === 'grooving' && (
                                <div className="grid grid-cols-2 gap-3">
                                  <div className="space-y-1">
                                    <Label className="text-xs">Groove Width (mm)</Label>
                                    <Input type="number" value={op.params.grooving?.grooveWidth || 3}
                                      onChange={e => {
                                        setLocalData(prev => prev ? ({ ...prev, operations: prev.operations.map(o => o.id === op.id ? { ...o, params: { ...o.params, grooving: { grooveWidth: parseFloat(e.target.value) || 3, grooveDepth: o.params.grooving?.grooveDepth || 5, grooveProfile: o.params.grooving?.grooveProfile || 'square', grooveCount: o.params.grooving?.grooveCount || 1, zPositions: o.params.grooving?.zPositions || [-50] } } } : o) }) : null);
                                        setHasUnsavedChanges(true);
                                      }} className="font-mono text-right" />
                                  </div>
                                  <div className="space-y-1">
                                    <Label className="text-xs">Groove Depth (mm)</Label>
                                    <Input type="number" value={op.params.grooving?.grooveDepth || 5}
                                      onChange={e => {
                                        setLocalData(prev => prev ? ({ ...prev, operations: prev.operations.map(o => o.id === op.id ? { ...o, params: { ...o.params, grooving: { ...o.params.grooving!, grooveDepth: parseFloat(e.target.value) || 5 } } } : o) }) : null);
                                        setHasUnsavedChanges(true);
                                      }} className="font-mono text-right" />
                                  </div>
                                  <div className="space-y-1 col-span-2">
                                    <Label className="text-xs">Groove Profile</Label>
                                    <Select value={op.params.grooving?.grooveProfile || 'square'}
                                      onValueChange={v => {
                                        setLocalData(prev => prev ? ({ ...prev, operations: prev.operations.map(o => o.id === op.id ? { ...o, params: { ...o.params, grooving: { ...o.params.grooving!, grooveProfile: v as any } } } : o) }) : null);
                                        setHasUnsavedChanges(true);
                                      }}>
                                      <SelectTrigger className="text-xs"><SelectValue /></SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="square">Square</SelectItem>
                                        <SelectItem value="v">V-Groove</SelectItem>
                                        <SelectItem value="round">Round</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                </div>
                              )}

                              {/* Threading-specific params */}
                              {op.type === 'threading' && (
                                <div className="grid grid-cols-2 gap-3">
                                  <div className="space-y-1">
                                    <Label className="text-xs">Pitch (mm)</Label>
                                    <Input type="number" step="0.1" value={op.params.threading?.pitch || 2}
                                      onChange={e => {
                                        setLocalData(prev => prev ? ({ ...prev, operations: prev.operations.map(o => o.id === op.id ? { ...o, params: { ...o.params, threading: { pitch: parseFloat(e.target.value) || 2, threadDepth: o.params.threading?.threadDepth || 1.3, threadType: o.params.threading?.threadType || 'external', threadForm: o.params.threading?.threadForm || 'v60', startZ: o.params.threading?.startZ || 0, endZ: o.params.threading?.endZ || -50, infeedAngle: o.params.threading?.infeedAngle || 29.5, springPasses: o.params.threading?.springPasses || 2, firstCutDepth: o.params.threading?.firstCutDepth || 0.3, minCutDepth: o.params.threading?.minCutDepth || 0.05 } } } : o) }) : null);
                                        setHasUnsavedChanges(true);
                                      }} className="font-mono text-right" />
                                  </div>
                                  <div className="space-y-1">
                                    <Label className="text-xs">Thread Depth (mm)</Label>
                                    <Input type="number" step="0.1" value={op.params.threading?.threadDepth || 1.3}
                                      onChange={e => {
                                        setLocalData(prev => prev ? ({ ...prev, operations: prev.operations.map(o => o.id === op.id ? { ...o, params: { ...o.params, threading: { ...o.params.threading!, threadDepth: parseFloat(e.target.value) || 1.3 } } } : o) }) : null);
                                        setHasUnsavedChanges(true);
                                      }} className="font-mono text-right" />
                                  </div>
                                  <div className="space-y-1">
                                    <Label className="text-xs">Type</Label>
                                    <Select value={op.params.threading?.threadType || 'external'}
                                      onValueChange={v => {
                                        setLocalData(prev => prev ? ({ ...prev, operations: prev.operations.map(o => o.id === op.id ? { ...o, params: { ...o.params, threading: { ...o.params.threading!, threadType: v as any } } } : o) }) : null);
                                        setHasUnsavedChanges(true);
                                      }}>
                                      <SelectTrigger className="text-xs"><SelectValue /></SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="external">External</SelectItem>
                                        <SelectItem value="internal">Internal</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  <div className="space-y-1">
                                    <Label className="text-xs">Spring Passes</Label>
                                    <Input type="number" value={op.params.threading?.springPasses || 2}
                                      onChange={e => {
                                        setLocalData(prev => prev ? ({ ...prev, operations: prev.operations.map(o => o.id === op.id ? { ...o, params: { ...o.params, threading: { ...o.params.threading!, springPasses: parseInt(e.target.value) || 2 } } } : o) }) : null);
                                        setHasUnsavedChanges(true);
                                      }} className="font-mono text-right" />
                                  </div>
                                </div>
                              )}

                              {/* Planing-specific params */}
                              {op.type === 'planing' && (
                                <div className="grid grid-cols-2 gap-3">
                                  <div className="space-y-1">
                                    <Label className="text-xs">Depth Per Pass (mm)</Label>
                                    <Input type="number" step="0.5" value={op.params.planing?.planerDepthPerPass || 2}
                                      onChange={e => {
                                        setLocalData(prev => prev ? ({ ...prev, operations: prev.operations.map(o => o.id === op.id ? { ...o, params: { ...o.params, planing: { planerDepthPerPass: parseFloat(e.target.value) || 2, surfaceTarget: o.params.planing?.surfaceTarget || 'top', flatteningAllowance: o.params.planing?.flatteningAllowance || 5, passDirection: o.params.planing?.passDirection || 'climb', aAxisAngle: o.params.planing?.aAxisAngle || 0 } } } : o) }) : null);
                                        setHasUnsavedChanges(true);
                                      }} className="font-mono text-right" />
                                  </div>
                                  <div className="space-y-1">
                                    <Label className="text-xs">Total Removal (mm)</Label>
                                    <Input type="number" step="0.5" value={op.params.planing?.flatteningAllowance || 5}
                                      onChange={e => {
                                        setLocalData(prev => prev ? ({ ...prev, operations: prev.operations.map(o => o.id === op.id ? { ...o, params: { ...o.params, planing: { ...o.params.planing!, flatteningAllowance: parseFloat(e.target.value) || 5 } } } : o) }) : null);
                                        setHasUnsavedChanges(true);
                                      }} className="font-mono text-right" />
                                  </div>
                                  <div className="space-y-1">
                                    <Label className="text-xs">A-Axis Angle (°)</Label>
                                    <Input type="number" value={op.params.planing?.aAxisAngle || 0}
                                      onChange={e => {
                                        setLocalData(prev => prev ? ({ ...prev, operations: prev.operations.map(o => o.id === op.id ? { ...o, params: { ...o.params, planing: { ...o.params.planing!, aAxisAngle: parseFloat(e.target.value) || 0 } } } : o) }) : null);
                                        setHasUnsavedChanges(true);
                                      }} className="font-mono text-right" />
                                  </div>
                                  <div className="space-y-1">
                                    <Label className="text-xs">Direction</Label>
                                    <Select value={op.params.planing?.passDirection || 'climb'}
                                      onValueChange={v => {
                                        setLocalData(prev => prev ? ({ ...prev, operations: prev.operations.map(o => o.id === op.id ? { ...o, params: { ...o.params, planing: { ...o.params.planing!, passDirection: v as any } } } : o) }) : null);
                                        setHasUnsavedChanges(true);
                                      }}>
                                      <SelectTrigger className="text-xs"><SelectValue /></SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="climb">Climb</SelectItem>
                                        <SelectItem value="conventional">Conventional</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                </div>
                              )}

                              {/* Engraving-specific params */}
                              {op.type === 'engraving' && (
                                <div className="grid grid-cols-2 gap-3">
                                  <div className="space-y-1 col-span-2">
                                    <Label className="text-xs">Text to Engrave</Label>
                                    <Input value={op.params.engraving?.text || ''}
                                      onChange={e => {
                                        setLocalData(prev => prev ? ({ ...prev, operations: prev.operations.map(o => o.id === op.id ? { ...o, params: { ...o.params, engraving: { text: e.target.value, engravingDepth: o.params.engraving?.engravingDepth || 1, surfaceAngle: o.params.engraving?.surfaceAngle || 0, position: o.params.engraving?.position || { z: -50, offset: 0 } } } } : o) }) : null);
                                        setHasUnsavedChanges(true);
                                      }} className="font-mono" placeholder="Enter text..." />
                                  </div>
                                  <div className="space-y-1">
                                    <Label className="text-xs">Engrave Depth (mm)</Label>
                                    <Input type="number" step="0.1" value={op.params.engraving?.engravingDepth || 1}
                                      onChange={e => {
                                        setLocalData(prev => prev ? ({ ...prev, operations: prev.operations.map(o => o.id === op.id ? { ...o, params: { ...o.params, engraving: { ...o.params.engraving!, engravingDepth: parseFloat(e.target.value) || 1 } } } : o) }) : null);
                                        setHasUnsavedChanges(true);
                                      }} className="font-mono text-right" />
                                  </div>
                                  <div className="space-y-1">
                                    <Label className="text-xs">Surface Angle (°)</Label>
                                    <Input type="number" value={op.params.engraving?.surfaceAngle || 0}
                                      onChange={e => {
                                        setLocalData(prev => prev ? ({ ...prev, operations: prev.operations.map(o => o.id === op.id ? { ...o, params: { ...o.params, engraving: { ...o.params.engraving!, surfaceAngle: parseFloat(e.target.value) || 0 } } } : o) }) : null);
                                        setHasUnsavedChanges(true);
                                      }} className="font-mono text-right" />
                                  </div>
                                </div>
                              )}

                              {/* 3D Carving-specific params */}
                              {op.type === 'carving_3d' && (
                                <div className="grid grid-cols-2 gap-3">
                                  <div className="space-y-1 col-span-2">
                                    <Label className="text-xs">Finishing Strategy</Label>
                                    <Select value={op.params.carving3d?.finishingStrategy || 'raster'}
                                      onValueChange={v => {
                                        setLocalData(prev => prev ? ({ ...prev, operations: prev.operations.map(o => o.id === op.id ? { ...o, params: { ...o.params, carving3d: { finishingStrategy: v as any, scallopHeight: o.params.carving3d?.scallopHeight || 0.1, stepdown: o.params.carving3d?.stepdown || 3, boundaryOffset: o.params.carving3d?.boundaryOffset || 2 } } } : o) }) : null);
                                        setHasUnsavedChanges(true);
                                      }}>
                                      <SelectTrigger className="text-xs"><SelectValue /></SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="raster">Raster (Zigzag)</SelectItem>
                                        <SelectItem value="spiral">Spiral</SelectItem>
                                        <SelectItem value="flowline">Flowline</SelectItem>
                                        <SelectItem value="constant_z">Constant Z</SelectItem>
                                        <SelectItem value="pencil">Pencil</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  <div className="space-y-1">
                                    <Label className="text-xs">Scallop Height (mm)</Label>
                                    <Input type="number" step="0.01" value={op.params.carving3d?.scallopHeight || 0.1}
                                      onChange={e => {
                                        setLocalData(prev => prev ? ({ ...prev, operations: prev.operations.map(o => o.id === op.id ? { ...o, params: { ...o.params, carving3d: { ...o.params.carving3d!, scallopHeight: parseFloat(e.target.value) || 0.1 } } } : o) }) : null);
                                        setHasUnsavedChanges(true);
                                      }} className="font-mono text-right" />
                                  </div>
                                  <div className="space-y-1">
                                    <Label className="text-xs">Stepdown (mm)</Label>
                                    <Input type="number" step="0.5" value={op.params.carving3d?.stepdown || 3}
                                      onChange={e => {
                                        setLocalData(prev => prev ? ({ ...prev, operations: prev.operations.map(o => o.id === op.id ? { ...o, params: { ...o.params, carving3d: { ...o.params.carving3d!, stepdown: parseFloat(e.target.value) || 3 } } } : o) }) : null);
                                        setHasUnsavedChanges(true);
                                      }} className="font-mono text-right" />
                                  </div>
                                </div>
                              )}

                              {/* 4-Axis Contouring-specific params */}
                              {op.type === 'contouring_4axis' && (
                                <div className="grid grid-cols-2 gap-3">
                                  <div className="space-y-1 col-span-2">
                                    <Label className="text-xs">Pattern Type</Label>
                                    <Select value={op.params.contouring4axis?.patternType || 'spiral_flute'}
                                      onValueChange={v => {
                                        setLocalData(prev => prev ? ({ ...prev, operations: prev.operations.map(o => o.id === op.id ? { ...o, params: { ...o.params, contouring4axis: { patternType: v as any, feedMode: o.params.contouring4axis?.feedMode || 'inverse_time' } } } : o) }) : null);
                                        setHasUnsavedChanges(true);
                                      }}>
                                      <SelectTrigger className="text-xs"><SelectValue /></SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="spiral_flute">Spiral Flute</SelectItem>
                                        <SelectItem value="wrapped_pattern">Wrapped Pattern</SelectItem>
                                        <SelectItem value="helical">Helical</SelectItem>
                                        <SelectItem value="custom">Custom</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  <div className="space-y-1">
                                    <Label className="text-xs">Feed Mode</Label>
                                    <Select value={op.params.contouring4axis?.feedMode || 'inverse_time'}
                                      onValueChange={v => {
                                        setLocalData(prev => prev ? ({ ...prev, operations: prev.operations.map(o => o.id === op.id ? { ...o, params: { ...o.params, contouring4axis: { ...o.params.contouring4axis!, feedMode: v as any } } } : o) }) : null);
                                        setHasUnsavedChanges(true);
                                      }}>
                                      <SelectTrigger className="text-xs"><SelectValue /></SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="standard">Standard (G94)</SelectItem>
                                        <SelectItem value="inverse_time">Inverse Time (G93)</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  {op.params.contouring4axis?.patternType === 'helical' && (
                                    <div className="space-y-1">
                                      <Label className="text-xs">Helical Pitch (mm)</Label>
                                      <Input type="number" step="0.5" value={op.params.contouring4axis?.helicalPitch || 10}
                                        onChange={e => {
                                          setLocalData(prev => prev ? ({ ...prev, operations: prev.operations.map(o => o.id === op.id ? { ...o, params: { ...o.params, contouring4axis: { ...o.params.contouring4axis!, helicalPitch: parseFloat(e.target.value) || 10 } } } : o) }) : null);
                                          setHasUnsavedChanges(true);
                                        }} className="font-mono text-right" />
                                    </div>
                                  )}
                                </div>
                              )}

                              {/* Sanding-specific params */}
                              {op.type === 'sanding' && (
                                <div className="grid grid-cols-2 gap-3">
                                  <div className="space-y-1 col-span-2">
                                    <Label className="text-xs">Paddle Offset (mm deeper than profile)</Label>
                                    <Input type="number" step="0.1" value={op.params.paddleOffset || 1.0}
                                      onChange={e => updateOperation(op.id, 'paddleOffset', parseFloat(e.target.value) || 1.0)}
                                      className="font-mono text-right" />
                                  </div>
                                </div>
                              )}

                              <div className="grid grid-cols-2 gap-3">
                                <div className="space-y-1">
                                  <Label className="text-xs">Feed Rate (mm/min)</Label>
                                  <Input
                                    type="number"
                                    value={op.params.feedRate}
                                    onChange={(e) => updateOperation(op.id, 'feedRate', parseFloat(e.target.value) || 0)}
                                    className="font-mono text-right"
                                    data-testid={`input-feedrate-${op.id}`}
                                  />
                                </div>
                                <div className="space-y-1">
                                  <Label className="text-xs">Spindle Speed (RPM)</Label>
                                  <Input
                                    type="number"
                                    value={op.params.spindleSpeed}
                                    onChange={(e) => updateOperation(op.id, 'spindleSpeed', parseFloat(e.target.value) || 0)}
                                    className="font-mono text-right"
                                    data-testid={`input-spindle-${op.id}`}
                                  />
                                </div>
                                <div className="space-y-1">
                                  <Label className="text-xs">Depth of Cut (mm)</Label>
                                  <Input
                                    type="number"
                                    value={op.params.depthOfCut}
                                    onChange={(e) => updateOperation(op.id, 'depthOfCut', parseFloat(e.target.value) || 0)}
                                    className="font-mono text-right"
                                    data-testid={`input-depth-${op.id}`}
                                  />
                                </div>
                                <div className="space-y-1">
                                  <Label className="text-xs">Rapid Feed (mm/min)</Label>
                                  <Input
                                    type="number"
                                    value={op.params.rapidFeedRate}
                                    onChange={(e) => updateOperation(op.id, 'rapidFeedRate', parseFloat(e.target.value) || 0)}
                                    className="font-mono text-right"
                                    data-testid={`input-rapid-${op.id}`}
                                  />
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </TabsContent>
            </ScrollArea>
          </Tabs>
        </aside>

        <main className="flex-1 flex flex-col relative">
          {showImporter ? (
            <div className="flex-1 flex items-center justify-center p-8">
              <div className="w-full max-w-lg">
                <FileImporter 
                  onImport={handleImport}
                  onCancel={() => setShowImporter(false)}
                />
              </div>
            </div>
          ) : (
            <>
              <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 flex gap-2 bg-card border border-border p-2 rounded-lg shadow-xl">
                <Button 
                  variant={isSimulating ? "destructive" : "default"}
                  size="sm"
                  onClick={toggleSimulation}
                  disabled={localData.toolpath.length === 0}
                  data-testid="button-simulate"
                >
                  {isSimulating ? (
                    <><Pause className="w-4 h-4 mr-2" /> Pause</>
                  ) : (
                    <><Play className="w-4 h-4 mr-2" /> Simulate</>
                  )}
                </Button>
                <Button 
                  variant="outline"
                  size="sm"
                  onClick={resetSimulation}
                  disabled={simulationProgress === 0}
                  data-testid="button-reset-simulation"
                >
                  <RotateCcw className="w-4 h-4" />
                </Button>
              </div>

              {collisionWarnings.length > 0 && (
                <div className="absolute top-4 right-4 z-10 max-w-xs">
                  <div className="bg-destructive/90 text-destructive-foreground p-3 rounded-lg shadow-lg">
                    <div className="flex items-center gap-2 font-semibold mb-1">
                      <AlertTriangle className="w-4 h-4" />
                      Collision Warnings
                    </div>
                    <ul className="text-xs space-y-1">
                      {collisionWarnings.slice(0, 3).map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                      {collisionWarnings.length > 3 && (
                        <li>...and {collisionWarnings.length - 3} more</li>
                      )}
                    </ul>
                  </div>
                </div>
              )}

              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 w-64">
                <Slider
                  value={[simulationProgress * 100]}
                  onValueChange={([v]) => {
                    setSimulationProgress(v / 100);
                    setIsSimulating(false);
                  }}
                  max={100}
                  step={0.1}
                  className="w-full"
                  data-testid="slider-simulation"
                />
                <div className="text-center text-xs text-muted-foreground mt-1">
                  {Math.round(simulationProgress * 100)}% complete
                </div>
              </div>

              <ThreeCanvas
                stock={localData.stock}
                toolpath={localData.toolpath}
                currentTool={currentTool}
                isSimulating={isSimulating}
                simulationProgress={simulationProgress}
                onSimulationComplete={() => {
                  setIsSimulating(false);
                  toast({ title: "Simulation complete" });
                }}
                className="flex-1"
                importedGeometry={localData.geometry}
              />
            </>
          )}
        </main>

        <aside className="w-80 border-l border-border bg-card/50 flex flex-col shrink-0">
          <div className="p-3 border-b border-border font-mono text-xs font-bold text-muted-foreground uppercase flex justify-between items-center gap-2">
            <span>G-Code Preview</span>
            {project.gcode && (
              <div className="flex gap-1">
                <Button 
                  variant="ghost" 
                  size="icon" 
                  className="h-6 w-6"
                  onClick={handleCopyGCode}
                  data-testid="button-copy-gcode"
                >
                  <Copy className="w-3 h-3" />
                </Button>
                <Button 
                  variant="ghost" 
                  size="icon" 
                  className="h-6 w-6"
                  onClick={handleDownloadGCode}
                  data-testid="button-download-gcode"
                >
                  <Download className="w-3 h-3" />
                </Button>
              </div>
            )}
          </div>
          <div className="flex-1 bg-zinc-950 p-4 font-mono text-xs text-green-400 overflow-auto whitespace-pre">
            {project.gcode || "(Click Generate to create G-code...)"}
          </div>
        </aside>
      </div>
    </div>
  );
}

function checkCollisions(data: ProjectData): string[] {
  const warnings: string[] = [];
  const { stock, toolpath } = data;
  
  if (!toolpath || toolpath.length === 0) return warnings;

  // Machine coordinate system:
  // Z0 = headstock/spindle face
  // Negative Z = toward tailstock (safe cutting direction)
  // Positive Z = behind headstock (collision zone!)
  
  for (let i = 0; i < toolpath.length; i++) {
    const point = toolpath[i];
    
    // Check for tool going behind headstock (positive Z is dangerous)
    if (point.z > 5) {
      warnings.push(`Point ${i}: Tool behind headstock at Z=+${point.z.toFixed(1)}mm`);
    }
    
    // Check for tool going beyond tailstock (past the stock length)
    if (point.z < -(stock.length + 20)) {
      warnings.push(`Point ${i}: Tool beyond tailstock at Z=${point.z.toFixed(1)}mm`);
    }
    
    // Check for tool plunging into centerline (radius too small)
    // Calculate radius - handles both 2-axis (y=0) and 4-axis (rotated x,y) data
    const radius = Math.sqrt(point.x * point.x + point.y * point.y);
    // Only warn if radius is very small AND it's not just a rotated coordinate
    // For 4-axis data, check if this is a real small-radius cut vs rotation artifact
    if (radius < 2 && point.z < 0 && Math.abs(point.a || 0) % 90 > 5) {
      warnings.push(`Point ${i}: Tool near centerline (R=${radius.toFixed(1)}mm) at Z=${point.z.toFixed(1)}mm`);
    }
  }

  return warnings.slice(0, 10);
}
