import { pgTable, text, serial, timestamp, jsonb, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// === TABLE DEFINITIONS ===

export const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  // Stores the CAD data for 4-axis machining
  data: jsonb("data").notNull().default({}), 
  gcode: text("gcode"), // Cached G-code
  createdAt: timestamp("created_at").defaultNow(),
});

export const tools = pgTable("tools", {
  id: serial("id").primaryKey(),
  toolNumber: integer("tool_number").notNull(), // T01, T02, etc.
  name: text("name").notNull(),
  type: text("type").notNull(), // 'turning', 'sanding', 'drilling', 'routing', 'milling'
  // Stores tool specifics: { diameter, tipRadius, cutWidth, etc. }
  params: jsonb("params").notNull().default({}),
});

// === SCHEMAS ===

export const insertProjectSchema = createInsertSchema(projects).omit({ 
  id: true, 
  createdAt: true 
});

export const insertToolSchema = createInsertSchema(tools).omit({ 
  id: true 
});

// === EXPLICIT TYPES ===

export type Project = typeof projects.$inferSelect;
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Tool = typeof tools.$inferSelect;
export type InsertTool = z.infer<typeof insertToolSchema>;

// Request types
export type CreateProjectRequest = InsertProject;
export type UpdateProjectRequest = Partial<InsertProject>;
export type CreateToolRequest = InsertTool;

// === 4-AXIS CATEK MACHINE TYPES ===

// 3D Point for 4-axis machining (X, Y, Z coordinates)
export interface Point3D {
  x: number; // X-axis position (perpendicular to workpiece axis)
  y: number; // Y-axis position (vertical)
  z: number; // Z-axis position (along workpiece axis)
}

// Toolpath point with rotation angle
export interface ToolpathPoint {
  x: number;
  y: number;
  z: number;
  a: number; // A-axis rotation angle (degrees)
  feedRate?: number; // Optional feed rate override
}

// Profile segment for 3D curved surfaces
export interface ProfileSegment3D {
  id: string;
  type: 'line' | 'arc_cw' | 'arc_ccw';
  start: Point3D;
  end: Point3D;
  startAngle?: number; // A-axis at start
  endAngle?: number;   // A-axis at end
  radius?: number;     // For arcs
}

// Stock shape type
export type StockType = 'round' | 'square';

// Stock material definition
export interface MachineStock {
  type?: StockType;    // Stock shape: round (cylinder) or square (rectangular)
  diameter: number;    // Stock diameter in mm (for round stock)
  width?: number;      // Stock width in mm (for square stock, X direction)
  height?: number;     // Stock height in mm (for square stock, Y direction)
  length: number;      // Stock length in mm (Z direction)
  zOffset: number;     // Workpiece zero offset
  material?: string;   // e.g., 'oak', 'maple', 'pine'
}

// Rotation mode for 4-axis operations
export type RotationMode = 'continuous' | 'indexed' | 'static';

// Operation definition for Catek 7-in-1
export interface Operation {
  id: string;
  toolNumber: number;  // Machine tool number (1-7)
  type: 'roughing' | 'finishing' | 'turning' | 'sanding' | 'drilling' | 'routing' | 'milling';
  rotationMode?: RotationMode;  // How the A-axis behaves during this operation
  params: {
    feedRate: number;       // mm/min
    rapidFeedRate: number;  // mm/min for G00 moves
    spindleSpeed: number;   // RPM
    depthOfCut?: number;    // mm per pass
    allowance?: number;     // Finishing allowance
    stepover?: number;      // For milling operations
    paddleOffset?: number;  // mm - how much deeper sanding paddles cut into part beyond profile
    indexAngle?: number;    // Degrees between indexed positions (for 'indexed' mode)
    indexCount?: number;    // Number of indexed positions around the part
  };
}

// Imported CAD geometry (from DXF, DWG, STEP, STL, or OBJ)
export interface ImportedGeometry {
  sourceFile: string;
  fileType: 'dxf' | 'dwg' | 'step' | 'iges' | 'stl' | 'obj';
  vertices: Point3D[];
  curves: ProfileSegment3D[];
  boundingBox: {
    min: Point3D;
    max: Point3D;
  };
  // For 3D mesh files (STL/OBJ)
  meshData?: {
    vertices: number[];  // Flat array of vertex positions [x1,y1,z1, x2,y2,z2, ...]
    normals?: number[];  // Flat array of normals
    indices?: number[];  // Triangle indices for indexed geometry
  };
}

// Complete project data structure
export interface ProjectData {
  stock: MachineStock;
  geometry?: ImportedGeometry;
  toolpath: ToolpathPoint[];
  operations: Operation[];
  machineSettings: {
    safeZ: number;           // Safe Z height for rapids
    safeX: number;           // Safe X position
    homeA: number;           // Home A-axis angle
    rapidFeed: number;       // Default rapid feed rate
    workFeed: number;        // Default work feed rate
  };
  quantity?: number;         // Number of pieces to cut (cycles through load/clamp/cut/unload)
}

// Tool parameter types for different tool types
export interface TurningToolParams {
  tipRadius: number;
  noseAngle: number;
  cutDirection: 'left' | 'right';
}

export interface SandingToolParams {
  diameter: number;
  grit: number;
  width: number;
}

export interface DrillToolParams {
  diameter: number;
  pointAngle: number;
  flutes: number;
}

export interface RouterToolParams {
  diameter: number;
  fluteLength: number;
  flutes: number;
}

export interface MillingToolParams {
  diameter: number;
  fluteLength: number;
  flutes: number;
  cornerRadius?: number;
}
