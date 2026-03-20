import { useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Trash2 } from "lucide-react";

interface GroovePatternEditorProps {
  stockDiameter: number;
  stockLength: number;
  grooveDepth: number;
  grooveWidth: number;
  zPositions: number[];
  onChange: (positions: number[]) => void;
}

/**
 * Visual groove position editor — shows side profile of workpiece.
 * Users click on the profile to place grooves at specific Z positions.
 */
export function GroovePatternEditor({
  stockDiameter, stockLength, grooveDepth, grooveWidth, zPositions, onChange,
}: GroovePatternEditorProps) {
  const viewWidth = 300;
  const viewHeight = 120;
  const margin = 20;
  const radius = stockDiameter / 2;

  const scaleZ = (viewWidth - margin * 2) / stockLength;
  const scaleR = (viewHeight - margin * 2) / stockDiameter;

  const drawProfile = useCallback((canvas: HTMLCanvasElement | null) => {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, viewWidth, viewHeight);

    const yCenter = viewHeight / 2;
    const xStart = margin;
    const xEnd = viewWidth - margin;

    // Stock outline (rectangle for side view)
    ctx.fillStyle = 'rgba(210, 105, 30, 0.1)';
    ctx.fillRect(xStart, yCenter - radius * scaleR, xEnd - xStart, stockDiameter * scaleR);
    ctx.strokeStyle = '#D2691E';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(xStart, yCenter - radius * scaleR, xEnd - xStart, stockDiameter * scaleR);

    // Centerline
    ctx.beginPath();
    ctx.setLineDash([4, 4]);
    ctx.moveTo(xStart, yCenter);
    ctx.lineTo(xEnd, yCenter);
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 0.5;
    ctx.stroke();
    ctx.setLineDash([]);

    // Z axis labels
    ctx.fillStyle = '#666';
    ctx.font = '9px monospace';
    ctx.fillText('Z=0', xStart - 2, viewHeight - 4);
    ctx.fillText(`Z=-${stockLength}`, xEnd - 30, viewHeight - 4);

    // Draw grooves
    for (let i = 0; i < zPositions.length; i++) {
      const z = zPositions[i];
      const x = xStart + Math.abs(z) * scaleZ;
      const halfWidth = (grooveWidth / 2) * scaleZ;

      // Top groove
      ctx.fillStyle = 'rgba(255, 68, 68, 0.3)';
      ctx.fillRect(x - halfWidth, yCenter - radius * scaleR, halfWidth * 2, grooveDepth * scaleR);
      // Bottom groove
      ctx.fillRect(x - halfWidth, yCenter + (radius - grooveDepth) * scaleR, halfWidth * 2, grooveDepth * scaleR);

      // Groove line
      ctx.beginPath();
      ctx.moveTo(x, yCenter - radius * scaleR);
      ctx.lineTo(x, yCenter + radius * scaleR);
      ctx.strokeStyle = '#ff4444';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Label
      ctx.fillStyle = '#ff6666';
      ctx.font = '8px monospace';
      ctx.fillText(`${i + 1}`, x - 3, yCenter - radius * scaleR - 4);
    }

    // Headstock indicator
    ctx.fillStyle = '#333';
    ctx.fillRect(0, yCenter - 30, margin - 2, 60);
    ctx.fillStyle = '#555';
    ctx.font = '7px sans-serif';
    ctx.fillText('H', 5, yCenter + 3);
  }, [stockDiameter, stockLength, grooveDepth, grooveWidth, zPositions, scaleZ, scaleR, radius]);

  // Handle click to add groove at Z position
  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;

    // Convert pixel X to Z position
    const zRatio = (x - margin) / (viewWidth - margin * 2);
    const z = -Math.round(zRatio * stockLength);

    if (z > 0 || z < -stockLength) return; // Out of bounds

    onChange([...zPositions, z]);
  };

  const removeGroove = (idx: number) => {
    onChange(zPositions.filter((_, i) => i !== idx));
  };

  return (
    <div className="space-y-2">
      <Label className="text-xs text-muted-foreground">Click the profile to place grooves</Label>
      <canvas
        ref={drawProfile}
        width={viewWidth}
        height={viewHeight}
        className="rounded border border-border cursor-crosshair w-full"
        onClick={handleCanvasClick}
        style={{ imageRendering: 'pixelated' }}
      />

      {/* Groove positions list */}
      <div className="flex flex-wrap gap-1">
        {zPositions.map((z, i) => (
          <Badge key={i} variant="outline" className="gap-1 font-mono text-[10px]">
            Z={z}
            <button onClick={() => removeGroove(i)} className="text-destructive hover:text-destructive/80 ml-1">×</button>
          </Badge>
        ))}
      </div>

      {/* Quick patterns */}
      <div className="flex gap-2">
        <Button variant="outline" size="sm" className="text-xs" onClick={() => {
          const spacing = stockLength / 6;
          onChange(Array.from({ length: 5 }, (_, i) => -Math.round(spacing * (i + 1))));
        }}>Evenly spaced (5)</Button>
        <Button variant="outline" size="sm" className="text-xs" onClick={() => onChange([])}>Clear all</Button>
      </div>
    </div>
  );
}
