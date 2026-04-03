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
  type: text("type").notNull(), // 'turning', 'sanding', 'drilling', 'routing', 'milling', 'grooving', 'planing', 'engraving', 'parting', 'boring', 'ball_nose', 'v_bit'
  // Stores tool specifics: { diameter, tipRadius, cutWidth, etc. }
  params: jsonb("params").notNull().default({}),
});

export const settings = pgTable("settings", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  value: jsonb("value").notNull().default({}),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// === SCHEMAS ===

export const insertProjectSchema = createInsertSchema(projects).omit({
  id: true,
  createdAt: true
});

export const insertToolSchema = createInsertSchema(tools).omit({
  id: true
});

export const insertSettingSchema = createInsertSchema(settings).omit({
  id: true,
  updatedAt: true,
});

// === EXPLICIT TYPES ===

export type Project = typeof projects.$inferSelect;
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Tool = typeof tools.$inferSelect;
export type InsertTool = z.infer<typeof insertToolSchema>;
export type Setting = typeof settings.$inferSelect;
export type InsertSetting = z.infer<typeof insertSettingSchema>;

// Request types
export type CreateProjectRequest = InsertProject;
export type UpdateProjectRequest = Partial<InsertProject>;
export type CreateToolRequest = InsertTool;

// === SPINDLE CONFIGURATION ===

export interface SpindleConfig {
  id: string;
  name: string;
  type: 'main' | 'milling1' | 'milling2' | 'milling3' | 'planer' | 'sanding';
  maxRPM: number;
  power: number; // kW
  mCodes: {
    start: string;   // e.g. 'M03' for forward
    stop: string;    // e.g. 'M05'
    reverse?: string; // e.g. 'M04'
  };
}

// === MACHINE CONFIGURATION (stored in settings table) ===

export interface MachineConfig {
  name: string;
  model: string; // e.g. 'CK-1530-7T' or 'CK-1530-7T-5AXIS'
  maxDiameter: number;  // mm
  maxLength: number;    // mm
  axes: number;         // 4 or 5
  hasB_axis: boolean;

  spindles: SpindleConfig[];

  // Default safe positions
  safeX: number;
  safeY: number;
  safeZ: number;

  // Default feeds/speeds
  defaultRapidFeed: number;
  defaultWorkFeed: number;
  defaultSpindleRPM: number;

  // Loader M-codes
  loaderCodes: {
    release: string;    // M69
    start: string;      // M70
    position: string;   // M71
    complete: string;   // M72
    clamp: string;      // M68
  };

  // Auxiliary M-codes
  auxCodes: {
    dustOn: string;     // M76
    dustOff: string;    // M77
  };

  // G-code post-processor settings
  postProcessor: {
    programEnd: string;       // M30
    toolFormat: 'Ttttt';      // Only Catek format for now
    coordinateSystem: string; // G55
    units: 'metric' | 'imperial';
    xAxisMode: 'diameter' | 'radius';
  };
}

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
  b?: number; // B-axis angle (5-axis only)
  feedRate?: number; // Optional feed rate override
  moveType?: 'rapid' | 'linear' | 'arc_cw' | 'arc_ccw'; // Motion type
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
  center?: Point3D;    // Arc center point (for G02/G03 I/J/K)
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
export type RotationMode = 'continuous' | 'indexed' | 'static' | 'simultaneous';

// All operation types for Catek 7-in-1
export type OperationType =
  | 'roughing'
  | 'finishing'
  | 'turning'
  | 'sanding'
  | 'drilling'
  | 'routing'
  | 'milling'
  | 'grooving'
  | 'planing'
  | 'engraving'
  | 'threading'
  | 'carving_3d'
  | 'contouring_4axis';

// === OPERATION-SPECIFIC PARAMETER TYPES ===

export interface DrillingParams {
  holeDepth: number;           // mm
  peckDepth: number;           // mm per peck
  retractHeight: number;       // mm above surface for retract
  dwellTime?: number;          // seconds at bottom
  drillCycle: 'spot' | 'peck' | 'deep_peck';
  throughHole: boolean;
  holePattern?: HolePattern;
}

export interface HolePattern {
  type: 'single' | 'bolt_circle' | 'linear' | 'indexed';
  positions: Point3D[];
  indexAngles?: number[];      // A-axis angles for indexed holes
  boltCircleRadius?: number;
  boltCircleCount?: number;
  linearSpacing?: number;
  linearCount?: number;
}

export interface GroovingParams {
  grooveWidth: number;         // mm
  grooveDepth: number;         // mm (radial depth from surface)
  grooveProfile: 'square' | 'v' | 'round' | 'custom';
  grooveSpacing?: number;      // mm between grooves
  grooveCount: number;
  zPositions: number[];        // Z positions for each groove
  vAngle?: number;             // degrees for V-groove
}

export interface ThreadingParams {
  pitch: number;               // mm per revolution
  threadDepth: number;         // mm (radial)
  threadType: 'external' | 'internal';
  threadForm: 'v60' | 'acme' | 'buttress' | 'custom';
  startZ: number;              // mm
  endZ: number;                // mm
  infeedAngle: number;         // degrees (29.5 typical for V-thread)
  springPasses: number;        // cleanup passes at final depth
  firstCutDepth: number;       // mm
  minCutDepth: number;         // mm
  taperAngle?: number;         // degrees for tapered threads
}

export interface PlaningParams {
  planerDepthPerPass: number;  // mm per pass
  surfaceTarget: 'top' | 'bottom' | 'side' | 'custom';
  flatteningAllowance: number; // mm target material removal
  passDirection: 'climb' | 'conventional';
  aAxisAngle: number;          // degrees - which face to plane
}

export interface EngravingParams {
  text?: string;
  fontFamily?: string;
  fontSize?: number;           // mm height
  svgPath?: string;            // SVG path data
  engravingDepth: number;      // mm
  surfaceAngle: number;        // A-axis angle for engraving surface
  position: { z: number; offset: number };
}

export interface Carving3DParams {
  finishingStrategy: 'raster' | 'spiral' | 'flowline' | 'constant_z' | 'pencil';
  rasterAngle?: number;        // degrees
  spiralPitch?: number;        // mm
  scallopHeight: number;       // mm target surface finish
  stepdown: number;            // mm per roughing level
  boundaryOffset: number;      // mm offset from stock edge
}

export interface Contouring4AxisParams {
  patternType: 'spiral_flute' | 'wrapped_pattern' | 'helical' | 'custom';
  helicalPitch?: number;       // mm per revolution
  wrapAngle?: number;          // degrees of wrap
  feedMode: 'standard' | 'inverse_time'; // G94 vs G93
}

// Operation definition for Catek 7-in-1
export interface Operation {
  id: string;
  toolNumber: number;  // Machine tool number (1-10)
  type: OperationType;
  rotationMode?: RotationMode;  // How the A-axis behaves during this operation
  spindleId?: string;           // Which spindle to use (from MachineConfig.spindles)
  compensationMode?: 'none' | 'left' | 'right'; // G40/G41/G42
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
    // Operation-specific params (stored inline for simplicity)
    drilling?: DrillingParams;
    grooving?: GroovingParams;
    threading?: ThreadingParams;
    planing?: PlaningParams;
    engraving?: EngravingParams;
    carving3d?: Carving3DParams;
    contouring4axis?: Contouring4AxisParams;
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
  // Units detected from file header (e.g., DXF $INSUNITS)
  // 1=inches, 2=feet, 4=mm, 5=cm, 6=meters — null if not detected
  detectedUnits?: 'mm' | 'inches' | 'feet' | 'cm' | 'meters' | null;
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
    safeY?: number;          // Safe Y position
    homeA: number;           // Home A-axis angle
    rapidFeed: number;       // Default rapid feed rate
    workFeed: number;        // Default work feed rate
  };
  quantity?: number;         // Number of pieces to cut (cycles through load/clamp/cut/unload)
}

// === TOOL PARAMETER TYPES ===

export interface ToolOffsets {
  offsetX: number;       // Geometry offset X
  offsetZ: number;       // Geometry offset Z
  wearOffsetX: number;   // Wear compensation X
  wearOffsetZ: number;   // Wear compensation Z
}

export interface TurningToolParams {
  tipRadius: number;
  noseAngle: number;
  cutDirection: 'left' | 'right';
  offsets?: ToolOffsets;
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
  spotDiameter?: number;
  offsets?: ToolOffsets;
}

export interface RouterToolParams {
  diameter: number;
  fluteLength: number;
  flutes: number;
  offsets?: ToolOffsets;
}

export interface MillingToolParams {
  diameter: number;
  fluteLength: number;
  flutes: number;
  cornerRadius?: number;
  offsets?: ToolOffsets;
}

export interface GroovingToolParams {
  cutWidth: number;      // mm
  maxDepth: number;      // mm
  profile: 'square' | 'v' | 'round';
  vAngle?: number;       // degrees for V-groove tool
  offsets?: ToolOffsets;
}

export interface PlanerToolParams {
  width: number;         // mm planer blade width
  cutDepth: number;      // mm max depth per pass
}

export interface VBitToolParams {
  angle: number;         // degrees (e.g. 60, 90)
  tipWidth: number;      // mm flat at tip (0 for sharp)
  maxDepth: number;      // mm
  offsets?: ToolOffsets;
}

export interface BallNoseToolParams {
  diameter: number;      // mm
  effectiveRadius: number; // mm (diameter/2)
  neckDiameter: number;  // mm
  fluteLength: number;   // mm
  flutes: number;
  offsets?: ToolOffsets;
}

export interface ThreadingToolParams {
  pitch: number;         // mm
  threadAngle: number;   // degrees (60 for V, 29 for acme)
  insertType: 'full' | 'partial';
  offsets?: ToolOffsets;
}

export interface PartingToolParams {
  cutWidth: number;
  offsets?: ToolOffsets;
}
