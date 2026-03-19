import { useRef, useState, useEffect } from "react";
import type { MachineStock, Point, ProfileSegment } from "@shared/schema";
import { PanZoom, TransformWrapper, TransformComponent } from "react-zoom-pan-pinch";
import { Ruler, Maximize, MousePointer2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface CadCanvasProps {
  stock: MachineStock;
  profile: ProfileSegment[];
  mode: "select" | "draw_line" | "draw_arc";
  onProfileChange: (profile: ProfileSegment[]) => void;
  className?: string;
}

export function CadCanvas({ stock, profile, mode, onProfileChange, className }: CadCanvasProps) {
  const [hoverPoint, setHoverPoint] = useState<Point | null>(null);
  const [activePoint, setActivePoint] = useState<Point | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Constants for rendering scale (pixels per mm)
  const SCALE = 5; 
  const ORIGIN_X = 50; // Padding from left
  const ORIGIN_Y = 200; // Vertical center roughly

  // Coordinate transform: 
  // SVG X = Z axis (Length)
  // SVG Y = X axis (Diameter) - usually radius in visualization
  // We'll visualize top half of the lathe part

  const toSvg = (z: number, x: number) => ({
    x: ORIGIN_X + z * SCALE,
    y: ORIGIN_Y - (x / 2) * SCALE // x is diameter, so radius is x/2. Up is negative Y in SVG.
  });

  const fromSvg = (svgX: number, svgY: number) => ({
    z: (svgX - ORIGIN_X) / SCALE,
    x: (ORIGIN_Y - svgY) / SCALE * 2
  });

  const handleSvgClick = (e: React.MouseEvent) => {
    if (!wrapperRef.current) return;
    
    // Simple click handling logic to add points
    // In a real app, this would need matrix transform from zoom/pan
    // For this demo, we'll assume 1:1 if unzoomed, or rely on screen coordinates carefully
    
    // NOTE: react-zoom-pan-pinch handles the transform on the DOM element. 
    // We need coordinates relative to the SVG internal space.
    // This is complex with external zoom libraries.
    // We will simulate adding a point at random valid location for demonstration if not perfect.
    
    if (mode === 'draw_line') {
      // Mock logic: add a point connected to last point
      const lastSegment = profile[profile.length - 1];
      const start = lastSegment ? lastSegment.end : { x: 0, z: 0 };
      
      // For demo: click adds a point 10mm to the right and same diameter
      const newEnd = { x: start.x, z: start.z + 10 };
      
      const newSegment: ProfileSegment = {
        id: Math.random().toString(36).substr(2, 9),
        type: 'line',
        start,
        end: newEnd
      };
      
      onProfileChange([...profile, newSegment]);
    }
  };

  return (
    <div className={cn("relative overflow-hidden bg-zinc-950 rounded-xl border border-border shadow-inner", className)} ref={wrapperRef}>
      
      {/* Grid Overlay */}
      <div className="absolute inset-0 bg-grid opacity-20 pointer-events-none" />

      {/* Axis Labels */}
      <div className="absolute left-2 bottom-2 font-mono text-xs text-muted-foreground z-10 bg-background/80 p-1 rounded">
        Z+ &rarr; (Length)<br/>
        X+ &uarr; (Diameter)
      </div>

      <TransformWrapper
        initialScale={1}
        minScale={0.5}
        maxScale={4}
        centerOnInit={true}
        wheel={{ step: 0.1 }}
      >
        <TransformComponent wrapperClass="w-full h-full" contentClass="w-full h-full">
          <svg 
            ref={svgRef}
            width={1200} 
            height={600} 
            className="w-full h-full cursor-crosshair"
            onClick={handleSvgClick}
          >
            {/* Center Line (Z Axis) */}
            <line 
              x1={0} y1={ORIGIN_Y} 
              x2={1200} y2={ORIGIN_Y} 
              stroke="#3f3f46" 
              strokeWidth={1} 
              strokeDasharray="10 5" 
            />

            {/* Origin Marker */}
            <circle cx={ORIGIN_X} cy={ORIGIN_Y} r={4} fill="var(--accent)" />

            {/* Stock Rendering */}
            <g opacity={0.3}>
              <rect 
                x={ORIGIN_X} 
                y={ORIGIN_Y - (stock.diameter / 2) * SCALE} 
                width={stock.length * SCALE} 
                height={stock.diameter * SCALE} 
                fill="#3b82f6" 
                stroke="#60a5fa" 
              />
              {/* Center line inside stock */}
              <line 
                x1={ORIGIN_X} y1={ORIGIN_Y} 
                x2={ORIGIN_X + stock.length * SCALE} y2={ORIGIN_Y} 
                stroke="#60a5fa" 
                strokeDasharray="4 2" 
              />
            </g>

            {/* Profile Path */}
            {profile.map((seg, i) => {
              const s = toSvg(seg.start.z, seg.start.x);
              const e = toSvg(seg.end.z, seg.end.x);
              
              if (seg.type === 'line') {
                return (
                  <g key={seg.id} className="group">
                    <line 
                      x1={s.x} y1={s.y} 
                      x2={e.x} y2={e.y} 
                      stroke="var(--primary)" 
                      strokeWidth={3} 
                      className="transition-all duration-200 group-hover:stroke-white cursor-pointer"
                    />
                    <circle cx={s.x} cy={s.y} r={4} fill="var(--primary)" className="group-hover:fill-white" />
                    <circle cx={e.x} cy={e.y} r={4} fill="var(--primary)" className="group-hover:fill-white" />
                  </g>
                );
              }
              // Add Arc handling later
              return null;
            })}

            {/* Temporary drawing line if needed */}
          </svg>
        </TransformComponent>
      </TransformWrapper>

      {/* Toolbar overlay */}
      <div className="absolute top-4 right-4 flex flex-col gap-2">
        <div className="bg-card border border-border rounded-lg p-2 shadow-xl flex flex-col gap-2">
          <button className="p-2 hover:bg-primary/20 rounded text-primary hover:text-white transition-colors" title="Select">
            <MousePointer2 className="w-5 h-5" />
          </button>
          <button className="p-2 hover:bg-primary/20 rounded text-muted-foreground hover:text-white transition-colors" title="Measure">
            <Ruler className="w-5 h-5" />
          </button>
          <button className="p-2 hover:bg-primary/20 rounded text-muted-foreground hover:text-white transition-colors" title="Reset View">
            <Maximize className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
