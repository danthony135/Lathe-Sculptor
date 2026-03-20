import { useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { AlertTriangle, CheckCircle2, ArrowRight, RotateCcw } from "lucide-react";
import type { ImportedGeometry, Operation } from "@shared/schema";

interface AnalysisData {
  shape: string;
  shapeConfidence: number;
  recommendedStock: { type?: string; diameter: number; length: number; material?: string };
  suggestedOperations: Operation[];
  features: { type: string; description: string; confidence: number; operationType: string }[];
  axisMapping: { length: string; radius: string };
  warnings: string[];
  estimatedCycleTime: number;
}

interface AxisConfirmDialogProps {
  open: boolean;
  geometry: ImportedGeometry;
  analysis: AnalysisData;
  onConfirm: (analysis: AnalysisData) => void;
  onCancel: () => void;
}

export function AxisConfirmDialog({
  open, geometry, analysis, onConfirm, onCancel,
}: AxisConfirmDialogProps) {
  const [lengthAxis, setLengthAxis] = useState(analysis.axisMapping.length);
  const [radiusAxis, setRadiusAxis] = useState(analysis.axisMapping.radius);

  const bbox = geometry.boundingBox;
  const spans = {
    x: Math.abs(bbox.max.x - bbox.min.x),
    y: Math.abs(bbox.max.y - bbox.min.y),
    z: Math.abs(bbox.max.z - bbox.min.z),
  };

  const cycleMin = Math.floor(analysis.estimatedCycleTime / 60);
  const cycleSec = analysis.estimatedCycleTime % 60;

  const shapeColors: Record<string, string> = {
    axisymmetric: 'bg-green-500/20 text-green-400',
    prismatic: 'bg-blue-500/20 text-blue-400',
    freeform: 'bg-purple-500/20 text-purple-400',
    unknown: 'bg-yellow-500/20 text-yellow-400',
  };

  const opTypeLabels: Record<string, string> = {
    roughing: 'Roughing',
    turning: 'Profile Turning',
    finishing: 'Finishing',
    sanding: 'Sanding',
    drilling: 'Drilling',
    grooving: 'Grooving',
    threading: 'Threading',
    milling: 'Milling',
    planing: 'Planing',
    engraving: 'Engraving',
    carving_3d: '3D Carving',
    contouring_4axis: '4-Axis Contouring',
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="bg-card border-border max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono text-lg">Geometry Analysis</DialogTitle>
          <DialogDescription>
            Review how your part was interpreted before proceeding.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* File info */}
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{geometry.sourceFile}</span>
            <Badge className={shapeColors[analysis.shape] || shapeColors.unknown}>
              {analysis.shape} ({Math.round(analysis.shapeConfidence * 100)}% confidence)
            </Badge>
          </div>

          {/* Axis mapping */}
          <div className="bg-muted/30 rounded-lg p-4 space-y-3">
            <h3 className="text-sm font-semibold">Axis Orientation</h3>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="bg-background rounded p-3 border border-border">
                <div className="text-xs text-muted-foreground mb-1">X span</div>
                <div className="font-mono font-bold text-sm">{spans.x.toFixed(1)} mm</div>
                {lengthAxis === 'x' && <Badge variant="outline" className="mt-1 text-[10px]">LENGTH</Badge>}
                {radiusAxis === 'x' && <Badge variant="outline" className="mt-1 text-[10px]">RADIUS</Badge>}
              </div>
              <div className="bg-background rounded p-3 border border-border">
                <div className="text-xs text-muted-foreground mb-1">Y span</div>
                <div className="font-mono font-bold text-sm">{spans.y.toFixed(1)} mm</div>
                {lengthAxis === 'y' && <Badge variant="outline" className="mt-1 text-[10px]">LENGTH</Badge>}
                {radiusAxis === 'y' && <Badge variant="outline" className="mt-1 text-[10px]">RADIUS</Badge>}
              </div>
              <div className="bg-background rounded p-3 border border-border">
                <div className="text-xs text-muted-foreground mb-1">Z span</div>
                <div className="font-mono font-bold text-sm">{spans.z.toFixed(1)} mm</div>
                {lengthAxis === 'z' && <Badge variant="outline" className="mt-1 text-[10px]">LENGTH</Badge>}
                {radiusAxis === 'z' && <Badge variant="outline" className="mt-1 text-[10px]">RADIUS</Badge>}
              </div>
            </div>
            <div className="flex gap-4 items-end">
              <div className="flex-1 space-y-1">
                <Label className="text-xs">Length axis (along lathe Z)</Label>
                <Select value={lengthAxis} onValueChange={setLengthAxis}>
                  <SelectTrigger className="text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="x">X ({spans.x.toFixed(0)}mm)</SelectItem>
                    <SelectItem value="y">Y ({spans.y.toFixed(0)}mm)</SelectItem>
                    <SelectItem value="z">Z ({spans.z.toFixed(0)}mm)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex-1 space-y-1">
                <Label className="text-xs">Radius axis (lathe X)</Label>
                <Select value={radiusAxis} onValueChange={setRadiusAxis}>
                  <SelectTrigger className="text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(['x', 'y', 'z'] as const).filter(a => a !== lengthAxis).map(a => (
                      <SelectItem key={a} value={a}>{a.toUpperCase()} ({spans[a].toFixed(0)}mm)</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {/* Recommended stock */}
          <div className="bg-muted/30 rounded-lg p-4">
            <h3 className="text-sm font-semibold mb-2">Recommended Stock</h3>
            <div className="flex gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">Type:</span>{' '}
                <span className="font-mono">{analysis.recommendedStock.type || 'round'}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Diameter:</span>{' '}
                <span className="font-mono">{analysis.recommendedStock.diameter}mm</span>
              </div>
              <div>
                <span className="text-muted-foreground">Length:</span>{' '}
                <span className="font-mono">{analysis.recommendedStock.length}mm</span>
              </div>
            </div>
          </div>

          {/* Detected features */}
          {analysis.features.length > 0 && (
            <div className="bg-muted/30 rounded-lg p-4">
              <h3 className="text-sm font-semibold mb-2">Detected Features</h3>
              <div className="space-y-1">
                {analysis.features.map((f, i) => (
                  <div key={i} className="flex items-center justify-between text-xs">
                    <span>{f.description}</span>
                    <Badge variant="secondary" className="text-[10px]">
                      {Math.round(f.confidence * 100)}%
                    </Badge>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Auto-generated operations */}
          <div className="bg-muted/30 rounded-lg p-4">
            <h3 className="text-sm font-semibold mb-2">
              Suggested Operations ({analysis.suggestedOperations.length})
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {analysis.suggestedOperations.map((op, i) => (
                <div key={i} className="flex items-center gap-1">
                  <Badge variant="outline" className="text-[10px] font-mono">
                    T{op.toolNumber.toString().padStart(2, '0')}
                  </Badge>
                  <span className="text-xs">{opTypeLabels[op.type] || op.type}</span>
                  {i < analysis.suggestedOperations.length - 1 && (
                    <ArrowRight className="w-3 h-3 text-muted-foreground mx-0.5" />
                  )}
                </div>
              ))}
            </div>
            <div className="text-xs text-muted-foreground mt-2">
              Estimated cycle time: {cycleMin}m {cycleSec}s per piece
            </div>
          </div>

          {/* Warnings */}
          {analysis.warnings.length > 0 && (
            <div className="bg-destructive/10 rounded-lg p-4 border border-destructive/30">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 text-destructive" />
                <h3 className="text-sm font-semibold text-destructive">Warnings</h3>
              </div>
              <ul className="text-xs space-y-1 text-destructive/80">
                {analysis.warnings.map((w, i) => (
                  <li key={i}>• {w}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onCancel}>Cancel Import</Button>
          <Button onClick={() => onConfirm(analysis)} className="gap-2">
            <CheckCircle2 className="w-4 h-4" />
            Confirm & Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
