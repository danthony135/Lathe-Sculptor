import { useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Trash2, Plus } from "lucide-react";
import type { HolePattern, Point3D } from "@shared/schema";

interface DrillPatternEditorProps {
  stockDiameter: number;
  stockLength: number;
  pattern: HolePattern;
  onChange: (pattern: HolePattern) => void;
}

/**
 * Visual drill pattern editor — shows workpiece cross-section and side view.
 * Users click to place holes at specific A-axis angles and Z positions.
 */
export function DrillPatternEditor({
  stockDiameter, stockLength, pattern, onChange,
}: DrillPatternEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const radius = stockDiameter / 2;
  const viewSize = 200;
  const margin = 20;

  // Draw cross-section
  const drawCrossSection = useCallback((ctx: CanvasRenderingContext2D) => {
    const cx = viewSize / 2;
    const cy = viewSize / 2;
    const scale = (viewSize - margin * 2) / stockDiameter;

    // Clear
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, viewSize, viewSize);

    // Stock circle
    ctx.beginPath();
    ctx.arc(cx, cy, radius * scale, 0, Math.PI * 2);
    ctx.strokeStyle = '#D2691E';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = 'rgba(210, 105, 30, 0.1)';
    ctx.fill();

    // Center crosshair
    ctx.beginPath();
    ctx.moveTo(cx - 5, cy);
    ctx.lineTo(cx + 5, cy);
    ctx.moveTo(cx, cy - 5);
    ctx.lineTo(cx, cy + 5);
    ctx.strokeStyle = '#666';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Angle guides (every 90°)
    for (let a = 0; a < 360; a += 90) {
      const rad = (a * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(rad) * radius * scale, cy - Math.sin(rad) * radius * scale);
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 0.5;
      ctx.stroke();
      ctx.fillStyle = '#555';
      ctx.font = '9px monospace';
      ctx.fillText(`${a}°`, cx + Math.cos(rad) * (radius * scale + 8) - 8, cy - Math.sin(rad) * (radius * scale + 8) + 3);
    }

    // Draw holes
    const angles = pattern.indexAngles || [0];
    angles.forEach((angle, i) => {
      const rad = (angle * Math.PI) / 180;
      const hx = cx + Math.cos(rad) * radius * scale * 0.8;
      const hy = cy - Math.sin(rad) * radius * scale * 0.8;

      ctx.beginPath();
      ctx.arc(hx, hy, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#ff4444';
      ctx.fill();
      ctx.strokeStyle = '#ff6666';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = '#fff';
      ctx.font = '8px monospace';
      ctx.fillText(`${i + 1}`, hx - 3, hy + 3);
    });
  }, [stockDiameter, radius, pattern]);

  // Handle click on cross-section to add hole at angle
  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left - viewSize / 2;
    const y = -(e.clientY - rect.top - viewSize / 2);
    const angle = Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);

    const currentAngles = pattern.indexAngles || [];
    onChange({
      ...pattern,
      type: 'indexed',
      indexAngles: [...currentAngles, angle],
      positions: [...pattern.positions, { x: 0, y: 0, z: -(stockLength / 2) }],
    });
  };

  // Redraw when pattern changes
  const canvasCallback = useCallback((canvas: HTMLCanvasElement | null) => {
    if (canvas) {
      (canvasRef as any).current = canvas;
      const ctx = canvas.getContext('2d');
      if (ctx) drawCrossSection(ctx);
    }
  }, [drawCrossSection]);

  const removeHole = (idx: number) => {
    const angles = [...(pattern.indexAngles || [])];
    const positions = [...pattern.positions];
    angles.splice(idx, 1);
    positions.splice(idx, 1);
    onChange({ ...pattern, indexAngles: angles, positions });
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-3">
        {/* Cross-section view */}
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Cross Section (click to add holes)</Label>
          <canvas
            ref={canvasCallback}
            width={viewSize}
            height={viewSize}
            className="rounded border border-border cursor-crosshair"
            onClick={handleCanvasClick}
          />
        </div>

        {/* Hole list */}
        <div className="flex-1 space-y-1">
          <Label className="text-xs text-muted-foreground">Holes ({(pattern.indexAngles || []).length})</Label>
          <div className="max-h-[180px] overflow-y-auto space-y-1">
            {(pattern.indexAngles || []).map((angle, i) => (
              <div key={i} className="flex items-center gap-2 text-xs bg-muted/30 rounded px-2 py-1">
                <Badge variant="secondary" className="font-mono text-[10px]">{i + 1}</Badge>
                <span className="font-mono">{angle}°</span>
                <span className="text-muted-foreground">Z={pattern.positions[i]?.z?.toFixed(0) || 0}</span>
                <Button variant="ghost" size="icon" className="h-5 w-5 ml-auto" onClick={() => removeHole(i)}>
                  <Trash2 className="w-3 h-3 text-destructive" />
                </Button>
              </div>
            ))}
            {(pattern.indexAngles || []).length === 0 && (
              <p className="text-xs text-muted-foreground py-4 text-center">Click the cross-section to add holes</p>
            )}
          </div>
        </div>
      </div>

      {/* Quick add buttons */}
      <div className="flex gap-2">
        <Button variant="outline" size="sm" className="text-xs" onClick={() => {
          onChange({ ...pattern, type: 'indexed', indexAngles: [0, 90, 180, 270], positions: [0, 90, 180, 270].map(() => ({ x: 0, y: 0, z: -(stockLength / 2) })) });
        }}>4-hole pattern</Button>
        <Button variant="outline" size="sm" className="text-xs" onClick={() => {
          onChange({ ...pattern, type: 'indexed', indexAngles: [0, 120, 240], positions: [0, 120, 240].map(() => ({ x: 0, y: 0, z: -(stockLength / 2) })) });
        }}>3-hole pattern</Button>
      </div>
    </div>
  );
}
