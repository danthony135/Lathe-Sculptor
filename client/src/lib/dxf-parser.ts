import DxfParser from 'dxf-parser';
// @ts-ignore - optional dependency, may not be installed
let LibreDwg: any, Dwg_File_Type: any;
try { ({ LibreDwg, Dwg_File_Type } = require('@mlightcad/libredwg-web')); } catch {};
import type { Point3D, ProfileSegment3D, ImportedGeometry } from '@shared/schema';

/**
 * Extract bounding box from DXF header $EXTMIN and $EXTMAX variables
 * This is useful for 3DSOLID entities where geometry is encoded
 */
function extractDxfHeaderBounds(dxfText: string): { min: Point3D; max: Point3D } | null {
  try {
    const lines = dxfText.split(/\r?\n/).map(l => l.trim());
    
    let extMin: Point3D | null = null;
    let extMax: Point3D | null = null;
    
    for (let i = 0; i < lines.length - 1; i++) {
      // Look for $EXTMIN
      if (lines[i] === '$EXTMIN') {
        extMin = { x: 0, y: 0, z: 0 };
        // Parse the following group codes (10=X, 20=Y, 30=Z)
        for (let j = i + 1; j < Math.min(i + 20, lines.length - 1); j += 2) {
          const code = parseInt(lines[j]);
          const value = parseFloat(lines[j + 1]);
          if (code === 10) extMin.x = value;
          else if (code === 20) extMin.y = value;
          else if (code === 30) extMin.z = value;
          else if (code === 9) break; // Next variable
        }
      }
      // Look for $EXTMAX
      if (lines[i] === '$EXTMAX') {
        extMax = { x: 0, y: 0, z: 0 };
        for (let j = i + 1; j < Math.min(i + 20, lines.length - 1); j += 2) {
          const code = parseInt(lines[j]);
          const value = parseFloat(lines[j + 1]);
          if (code === 10) extMax.x = value;
          else if (code === 20) extMax.y = value;
          else if (code === 30) extMax.z = value;
          else if (code === 9) break; // Next variable
        }
      }
      
      // Stop once we've found both
      if (extMin && extMax) break;
    }
    
    if (extMin && extMax) {
      return { min: extMin, max: extMax };
    }
    
    return null;
  } catch (error) {
    console.error('Error extracting DXF header bounds:', error);
    return null;
  }
}

/**
 * Machine parameters for the Catek CNC 7-in-1 Wood Lathe
 * Used for automatic geometry adjustment on import
 */
export interface MachineParameters {
  maxStockLength: number;   // Maximum Z travel (mm), 1500 for Catek
  maxStockDiameter: number; // Maximum workpiece diameter (mm), 300 for Catek
  safeZClearance: number;   // Clearance from Z0 (mm)
  safeXClearance: number;   // Clearance from stock surface (mm)
}

export const DEFAULT_MACHINE_PARAMS: MachineParameters = {
  maxStockLength: 1500,
  maxStockDiameter: 300,
  safeZClearance: 5,
  safeXClearance: 10,
};

export interface GeometryAdjustment {
  translation: { x: number; y: number; z: number };
  warnings: string[];
  originalBounds: { min: Point3D; max: Point3D };
  adjustedBounds: { min: Point3D; max: Point3D };
  recommendedStock: { diameter: number; length: number };
}

/**
 * Adjust imported geometry to safe machine position
 * 
 * DXF lathe profiles are typically drawn as 2D cross-sections:
 * - DXF X axis = position along the part length → maps to Machine Z
 * - DXF Y axis = radius from centerline → maps to Machine Y (and X for visualization)
 * - DXF Z axis = typically 0 (2D drawing)
 * 
 * Machine coordinates (Catek CNC):
 * - Z axis: Z0 at spindle face, negative toward tailstock (0 >= Z >= -maxLength)
 * - X/Y: Radial distance from centerline
 * 
 * NO SCALING: Just remaps axes and translates, then returns recommended stock dimensions
 */
export function adjustGeometryToMachine(
  geometry: ImportedGeometry,
  machineParams: MachineParameters = DEFAULT_MACHINE_PARAMS
): { geometry: ImportedGeometry; adjustment: GeometryAdjustment } {
  const warnings: string[] = [];
  const bounds = geometry.boundingBox;
  
  // Calculate geometry dimensions in DXF space
  const dxfXSpan = bounds.max.x - bounds.min.x; // Length in DXF (maps to machine Z)
  const dxfYSpan = bounds.max.y - bounds.min.y; // Radius/height in DXF (maps to machine Y)
  const dxfZSpan = bounds.max.z - bounds.min.z; // Usually 0 for 2D profiles
  
  // Detect if this is a 2D profile (DXF Z is flat or nearly flat)
  const is2DProfile = dxfZSpan < 1;
  
  // Track which DXF axis maps to length and radius
  let partLength: number;
  let partRadius: number;
  let lengthAxisIsY = false; // Track which DXF axis is the length (for 2D profiles)
  // For 3D geometry: which DXF axis is length and which is the primary radial axis
  let dxfLengthAxis: 'x' | 'y' | 'z' = 'x';
  let dxfRadialAxis: 'x' | 'y' | 'z' = 'z';
  
  if (is2DProfile) {
    // 2D profile: determine which axis is longer (that's the length)
    if (dxfYSpan > dxfXSpan) {
      // DXF Y is length, DXF X is radius
      lengthAxisIsY = true;
      partLength = dxfYSpan;
      partRadius = Math.max(Math.abs(bounds.max.x), Math.abs(bounds.min.x));
    } else {
      // DXF X is length, DXF Y is radius
      lengthAxisIsY = false;
      partLength = dxfXSpan;
      partRadius = Math.max(Math.abs(bounds.max.y), Math.abs(bounds.min.y));
    }
  } else {
    // 3D geometry: detect which axes are radial vs length for a solid of revolution.
    // Key heuristic: radial axes are centered on zero (min ≈ -max), meaning the part
    // was modeled around the lathe centerline. The length axis is NOT centered — it
    // typically starts near 0 and extends in one direction.
    //
    // Example: a turned leg might have:
    //   X: -4.5 to 9.9 (length axis, not centered)
    //   Y: -1.3 to 6.7 (not centered — off-axis profile or half-profile)
    //   Z: -8.0 to 8.0 (centered on zero — this is the radial/diameter axis)

    const centeredness = {
      x: dxfXSpan > 0.1 ? Math.abs(bounds.max.x + bounds.min.x) / dxfXSpan : 1,
      y: dxfYSpan > 0.1 ? Math.abs(bounds.max.y + bounds.min.y) / dxfYSpan : 1,
      z: dxfZSpan > 0.1 ? Math.abs(bounds.max.z + bounds.min.z) / dxfZSpan : 1,
    };
    // A value near 0 means the axis is centered on zero (likely radial).
    // A value near 1+ means it's offset from zero (likely the length axis).

    type Axis = 'x' | 'y' | 'z';
    const axes: { axis: Axis; span: number; centered: number }[] = [
      { axis: 'x', span: dxfXSpan, centered: centeredness.x },
      { axis: 'y', span: dxfYSpan, centered: centeredness.y },
      { axis: 'z', span: dxfZSpan, centered: centeredness.z },
    ];

    // Identify radial axes: centered on zero (centeredness < 0.15)
    const radialAxes = axes.filter(a => a.centered < 0.15 && a.span > 0.1);
    const nonRadialAxes = axes.filter(a => a.centered >= 0.15 || a.span <= 0.1);

    if (radialAxes.length >= 1 && nonRadialAxes.length >= 1) {
      // Use the most off-center axis as length, largest radial axis as radius
      const lengthAxisInfo = nonRadialAxes.sort((a, b) => b.span - a.span)[0];
      const radiusAxisInfo = radialAxes.sort((a, b) => b.span - a.span)[0];

      partLength = lengthAxisInfo.span;
      partRadius = radiusAxisInfo.span / 2;
      dxfLengthAxis = lengthAxisInfo.axis;
      dxfRadialAxis = radiusAxisInfo.axis;
      lengthAxisIsY = lengthAxisInfo.axis === 'y';
    } else {
      // Fallback: longest axis is length (original behavior)
      if (dxfZSpan >= dxfXSpan && dxfZSpan >= dxfYSpan) {
        partLength = dxfZSpan;
        partRadius = Math.max(dxfXSpan, dxfYSpan) / 2;
        dxfLengthAxis = 'z';
        dxfRadialAxis = dxfXSpan >= dxfYSpan ? 'x' : 'y';
      } else if (dxfXSpan >= dxfYSpan) {
        partLength = dxfXSpan;
        partRadius = Math.max(Math.abs(bounds.max.y), Math.abs(bounds.min.y));
        dxfLengthAxis = 'x';
        dxfRadialAxis = dxfYSpan >= dxfZSpan ? 'y' : 'z';
      } else {
        lengthAxisIsY = true;
        partLength = dxfYSpan;
        partRadius = Math.max(Math.abs(bounds.max.x), Math.abs(bounds.min.x));
        dxfLengthAxis = 'y';
        dxfRadialAxis = dxfXSpan >= dxfZSpan ? 'x' : 'z';
      }
    }
  }
  
  // Transform vertices: remap DXF axes to machine axes
  // Machine Z = length axis (0 to -length, toward tailstock)
  // Machine Y = profile depth/radius
  // Machine X = typically 0 for 2D profiles
  const adjustedVertices: Point3D[] = geometry.vertices.map(v => {
    if (is2DProfile) {
      if (lengthAxisIsY) {
        // DXF Y is length → Machine Z, DXF X is profile → Machine Y
        return {
          x: v.z, // DXF Z → Machine X (usually 0)
          y: v.x, // DXF X → Machine Y (profile depth)
          z: -(v.y - bounds.min.y), // DXF Y → Machine Z (0 to -length)
        };
      } else {
        // DXF X is length → Machine Z, DXF Y is profile → Machine Y
        return {
          x: v.z, // DXF Z → Machine X (usually 0)
          y: v.y, // DXF Y → Machine Y (profile depth)
          z: -(v.x - bounds.min.x), // DXF X → Machine Z (0 to -length)
        };
      }
    } else {
      // 3D geometry: remap DXF axes to machine axes based on detected length/radial axes
      // Machine Z = length axis (0 to -length), Machine Y = primary radial, Machine X = secondary radial
      const lengthVal = v[dxfLengthAxis];
      const radialVal = v[dxfRadialAxis];
      // The third axis (neither length nor primary radial)
      const thirdAxis = (['x', 'y', 'z'] as const).find(a => a !== dxfLengthAxis && a !== dxfRadialAxis)!;
      const thirdVal = v[thirdAxis];
      return {
        x: thirdVal,                                          // Secondary radial → Machine X
        y: radialVal,                                         // Primary radial → Machine Y (profile radius)
        z: -(lengthVal - bounds.min[dxfLengthAxis]),          // Length → Machine Z (0 to -length)
      };
    }
  });
  
  // Transform curves similarly - preserve original profile coordinates
  const adjustedCurves: ProfileSegment3D[] = geometry.curves.map(c => {
    if (is2DProfile) {
      if (lengthAxisIsY) {
        // DXF Y is length → Machine Z, DXF X is profile → Machine Y
        return {
          ...c,
          start: {
            x: c.start.z,
            y: c.start.x, // Profile depth
            z: -(c.start.y - bounds.min.y),
          },
          end: {
            x: c.end.z,
            y: c.end.x, // Profile depth
            z: -(c.end.y - bounds.min.y),
          },
        };
      } else {
        // DXF X is length → Machine Z, DXF Y is profile → Machine Y
        return {
          ...c,
          start: {
            x: c.start.z,
            y: c.start.y, // Profile depth
            z: -(c.start.x - bounds.min.x),
          },
          end: {
            x: c.end.z,
            y: c.end.y, // Profile depth
            z: -(c.end.x - bounds.min.x),
          },
        };
      }
    } else {
      // 3D geometry: remap axes same as vertices
      const thirdAxis = (['x', 'y', 'z'] as const).find(a => a !== dxfLengthAxis && a !== dxfRadialAxis)!;
      return {
        ...c,
        start: {
          x: c.start[thirdAxis],
          y: c.start[dxfRadialAxis],
          z: -(c.start[dxfLengthAxis] - bounds.min[dxfLengthAxis]),
        },
        end: {
          x: c.end[thirdAxis],
          y: c.end[dxfRadialAxis],
          z: -(c.end[dxfLengthAxis] - bounds.min[dxfLengthAxis]),
        },
      };
    }
  });
  
  // Calculate new bounding box
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  
  for (const v of adjustedVertices) {
    minX = Math.min(minX, v.x);
    minY = Math.min(minY, v.y);
    minZ = Math.min(minZ, v.z);
    maxX = Math.max(maxX, v.x);
    maxY = Math.max(maxY, v.y);
    maxZ = Math.max(maxZ, v.z);
  }
  
  const adjustedBounds = {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
  };
  
  // Calculate translation that was applied (for reporting)
  let translation: { x: number; y: number; z: number };
  if (is2DProfile) {
    translation = lengthAxisIsY 
      ? { x: 0, y: 0, z: -bounds.min.y }
      : { x: 0, y: 0, z: -bounds.min.x };
  } else {
    translation = { x: 0, y: 0, z: -bounds.min[dxfLengthAxis] };
  }
  
  // Round up to practical stock sizes with margin
  const recommendedDiameter = Math.ceil((partRadius * 2 + 5) / 5) * 5; // Round up to nearest 5mm, add 5mm margin
  const recommendedLength = Math.ceil((partLength + 10) / 10) * 10; // Round up to nearest 10mm, add 10mm margin
  
  const recommendedStock = {
    diameter: Math.min(recommendedDiameter, machineParams.maxStockDiameter),
    length: Math.min(recommendedLength, machineParams.maxStockLength),
  };
  
  // Check against machine limits
  if (partRadius * 2 > machineParams.maxStockDiameter) {
    warnings.push(`Part diameter (${(partRadius * 2).toFixed(1)}mm) exceeds machine maximum (${machineParams.maxStockDiameter}mm).`);
  }
  if (partLength > machineParams.maxStockLength) {
    warnings.push(`Part length (${partLength.toFixed(1)}mm) exceeds machine maximum (${machineParams.maxStockLength}mm).`);
  }
  
  // Transform meshData if present (for STL/OBJ files)
  let adjustedMeshData = geometry.meshData;
  if (geometry.meshData?.vertices && geometry.meshData.vertices.length > 0) {
    const meshVerts = geometry.meshData.vertices;
    const transformedMeshVerts: number[] = [];
    
    for (let i = 0; i < meshVerts.length; i += 3) {
      const vx = meshVerts[i];
      const vy = meshVerts[i + 1];
      const vz = meshVerts[i + 2];
      
      let tx: number, ty: number, tz: number;
      
      if (is2DProfile) {
        if (lengthAxisIsY) {
          tx = vz;
          ty = vx;
          tz = -(vy - bounds.min.y);
        } else {
          tx = vz;
          ty = vy;
          tz = -(vx - bounds.min.x);
        }
      } else {
        // 3D geometry: remap axes same as vertex transformation
        const vArr = { x: vx, y: vy, z: vz };
        const thirdAxis = (['x', 'y', 'z'] as const).find(a => a !== dxfLengthAxis && a !== dxfRadialAxis)!;
        tx = vArr[thirdAxis];
        ty = vArr[dxfRadialAxis];
        tz = -(vArr[dxfLengthAxis] - bounds.min[dxfLengthAxis]);
      }
      
      transformedMeshVerts.push(tx, ty, tz);
    }
    
    adjustedMeshData = {
      ...geometry.meshData,
      vertices: transformedMeshVerts,
    };
  }
  
  const adjustedGeometry: ImportedGeometry = {
    ...geometry,
    vertices: adjustedVertices,
    curves: adjustedCurves,
    boundingBox: adjustedBounds,
    meshData: adjustedMeshData,
  };
  
  const adjustment: GeometryAdjustment = {
    translation,
    warnings,
    originalBounds: bounds,
    adjustedBounds,
    recommendedStock,
  };
  
  return { geometry: adjustedGeometry, adjustment };
}

export interface DxfEntity {
  type: string;
  layer?: string;
  vertices?: Array<{ x: number; y: number; z?: number }>;
  startPoint?: { x: number; y: number; z?: number };
  endPoint?: { x: number; y: number; z?: number };
  center?: { x: number; y: number; z?: number };
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  controlPoints?: Array<{ x: number; y: number; z?: number }>;
}

export interface ParsedDxf {
  entities: DxfEntity[];
  layers: string[];
  boundingBox: {
    min: Point3D;
    max: Point3D;
  };
}

/**
 * Detect units from DXF $INSUNITS header variable.
 * $INSUNITS values: 0=unitless, 1=inches, 2=feet, 4=mm, 5=cm, 6=meters
 * Also checks $MEASUREMENT: 0=imperial, 1=metric
 */
function detectDxfUnits(text: string): ImportedGeometry['detectedUnits'] {
  const lines = text.split(/\r?\n/).map(l => l.trim());

  // Look for $INSUNITS in HEADER section
  for (let i = 0; i < lines.length - 2; i++) {
    if (lines[i] === '$INSUNITS') {
      // Next group code should be 70, value is the unit code
      for (let j = i + 1; j < Math.min(i + 6, lines.length - 1); j += 2) {
        const code = parseInt(lines[j]);
        if (code === 70) {
          const unitCode = parseInt(lines[j + 1]);
          switch (unitCode) {
            case 1: return 'inches';
            case 2: return 'feet';
            case 4: return 'mm';
            case 5: return 'cm';
            case 6: return 'meters';
            default: return null;
          }
        }
        if (code === 9) break; // Hit next variable, stop
      }
    }
  }

  // Fallback: check $MEASUREMENT (0=imperial/inches, 1=metric/mm)
  for (let i = 0; i < lines.length - 2; i++) {
    if (lines[i] === '$MEASUREMENT') {
      for (let j = i + 1; j < Math.min(i + 6, lines.length - 1); j += 2) {
        const code = parseInt(lines[j]);
        if (code === 70) {
          const val = parseInt(lines[j + 1]);
          return val === 0 ? 'inches' : val === 1 ? 'mm' : null;
        }
        if (code === 9) break;
      }
    }
  }

  return null;
}

/**
 * Heuristic: if no $INSUNITS found, guess based on bounding box dimensions.
 * Typical lathe parts: furniture legs 4-36", spindles 1-8" diameter.
 * If max dimension is < 50, it's very likely inches (would be tiny in mm).
 * If max dimension is > 100, it's likely mm already.
 */
function guessUnitsFromDimensions(bbox: { min: Point3D; max: Point3D }): ImportedGeometry['detectedUnits'] {
  const xSpan = Math.abs(bbox.max.x - bbox.min.x);
  const ySpan = Math.abs(bbox.max.y - bbox.min.y);
  const zSpan = Math.abs(bbox.max.z - bbox.min.z);
  const maxSpan = Math.max(xSpan, ySpan, zSpan);

  // If all dimensions are very small, almost certainly inches
  // An 8-inch leg = 8 units, a 36-inch table leg = 36 units
  // In mm, even a small part would be 50+ mm
  if (maxSpan > 0.5 && maxSpan < 50) {
    return 'inches';
  }

  return null;
}

export async function parseDxfFile(file: File): Promise<ImportedGeometry> {
  const text = await file.text();
  const parser = new DxfParser();

  // Detect units from DXF header before parsing geometry
  const detectedUnits = detectDxfUnits(text);

  try {
    const dxf = parser.parseSync(text);

    if (!dxf) {
      throw new Error('Invalid DXF file: Could not parse file');
    }

    // Collect all entities from main section and blocks
    let allEntities: any[] = [];
    
    if (dxf.entities && dxf.entities.length > 0) {
      allEntities = [...dxf.entities];
    }
    
    // Also check blocks for entities (some DXF files store geometry in blocks)
    if (dxf.blocks) {
      for (const blockName in dxf.blocks) {
        const block = dxf.blocks[blockName];
        if (block.entities && block.entities.length > 0) {
          allEntities = [...allEntities, ...block.entities];
        }
      }
    }
    
    // Log entity types for debugging
    const entityTypes = new Set(allEntities.map(e => e.type));
    // DXF entity summary (debug only)

    if (allEntities.length === 0) {
      throw new Error('Invalid DXF file: No entities found in file or blocks');
    }

    const vertices: Point3D[] = [];
    const curves: ProfileSegment3D[] = [];
    
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    const updateBounds = (x: number, y: number, z: number) => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, z);
    };

    let segmentId = 0;

    for (const rawEntity of allEntities) {
      const entity = rawEntity as any;
      switch (entity.type) {
        case 'LINE': {
          // Handle both vertex array format and startPoint/endPoint format
          let start: Point3D;
          let end: Point3D;
          
          if (entity.vertices && entity.vertices.length >= 2) {
            start = {
              x: entity.vertices[0]?.x || 0,
              y: entity.vertices[0]?.y || 0,
              z: entity.vertices[0]?.z || 0,
            };
            end = {
              x: entity.vertices[1]?.x || 0,
              y: entity.vertices[1]?.y || 0,
              z: entity.vertices[1]?.z || 0,
            };
          } else {
            // Alternative format with startPoint/endPoint
            start = {
              x: entity.startPoint?.x ?? entity.start?.x ?? 0,
              y: entity.startPoint?.y ?? entity.start?.y ?? 0,
              z: entity.startPoint?.z ?? entity.start?.z ?? 0,
            };
            end = {
              x: entity.endPoint?.x ?? entity.end?.x ?? 0,
              y: entity.endPoint?.y ?? entity.end?.y ?? 0,
              z: entity.endPoint?.z ?? entity.end?.z ?? 0,
            };
          }
          
          vertices.push(start, end);
          updateBounds(start.x, start.y, start.z);
          updateBounds(end.x, end.y, end.z);
          
          curves.push({
            id: `seg-${segmentId++}`,
            type: 'line',
            start,
            end,
          });
          break;
        }
        
        case 'POINT': {
          // Handle POINT entities
          const point: Point3D = {
            x: entity.position?.x ?? entity.x ?? 0,
            y: entity.position?.y ?? entity.y ?? 0,
            z: entity.position?.z ?? entity.z ?? 0,
          };
          vertices.push(point);
          updateBounds(point.x, point.y, point.z);
          break;
        }

        case 'ARC': {
          const center = entity.center || { x: 0, y: 0, z: 0 };
          const arcRadius = entity.radius || 0;
          let startAngleDeg = entity.startAngle || 0;
          let endAngleDeg = entity.endAngle || 360;
          
          // Handle angle wrapping
          let startAngle = (startAngleDeg * Math.PI) / 180;
          let endAngle = (endAngleDeg * Math.PI) / 180;
          
          // Calculate arc span
          let arcSpan = endAngle - startAngle;
          if (arcSpan < 0) arcSpan += 2 * Math.PI;
          
          // Sample arc into multiple points (1 point per 5 degrees minimum, or more for larger arcs)
          const samplesPerDegree = 0.2; // 1 sample per 5 degrees
          const numSamples = Math.max(5, Math.ceil(Math.abs(arcSpan * 180 / Math.PI) * samplesPerDegree));
          
          const arcPoints: Point3D[] = [];
          for (let i = 0; i <= numSamples; i++) {
            const t = i / numSamples;
            const angle = startAngle + t * arcSpan;
            const point: Point3D = {
              x: center.x + arcRadius * Math.cos(angle),
              y: center.y + arcRadius * Math.sin(angle),
              z: center.z || 0,
            };
            arcPoints.push(point);
            vertices.push(point);
            updateBounds(point.x, point.y, point.z);
          }
          
          // Create line segments between consecutive arc points
          for (let i = 0; i < arcPoints.length - 1; i++) {
            curves.push({
              id: `seg-${segmentId++}`,
              type: 'line',
              start: arcPoints[i],
              end: arcPoints[i + 1],
            });
          }
          break;
        }

        case 'CIRCLE': {
          const center = entity.center || { x: 0, y: 0, z: 0 };
          const radius = entity.radius || 0;
          
          const numPoints = 36;
          for (let i = 0; i < numPoints; i++) {
            const angle = (i / numPoints) * Math.PI * 2;
            const nextAngle = ((i + 1) / numPoints) * Math.PI * 2;
            
            const start: Point3D = {
              x: center.x + radius * Math.cos(angle),
              y: center.y + radius * Math.sin(angle),
              z: center.z || 0,
            };
            const end: Point3D = {
              x: center.x + radius * Math.cos(nextAngle),
              y: center.y + radius * Math.sin(nextAngle),
              z: center.z || 0,
            };
            
            vertices.push(start);
            updateBounds(start.x, start.y, start.z);
            
            curves.push({
              id: `seg-${segmentId++}`,
              type: 'arc_ccw',
              start,
              end,
              radius,
            });
          }
          break;
        }

        case 'LWPOLYLINE':
        case 'POLYLINE': {
          const entityVertices = entity.vertices || [];
          for (let i = 0; i < entityVertices.length - 1; i++) {
            const v1 = entityVertices[i] as any;
            const v2 = entityVertices[i + 1] as any;
            const start: Point3D = {
              x: v1.x || 0,
              y: v1.y || 0,
              z: v1.z || 0,
            };
            const end: Point3D = {
              x: v2.x || 0,
              y: v2.y || 0,
              z: v2.z || 0,
            };
            
            // Check for bulge (curved segment)
            const bulge = v1.bulge || 0;
            
            if (Math.abs(bulge) > 0.001) {
              // This is a curved segment - tessellate it
              // Bulge = tan(arc_angle/4), where arc_angle is the included angle
              const arcAngle = 4 * Math.atan(Math.abs(bulge));
              
              // Calculate chord length and arc radius
              const dx = end.x - start.x;
              const dy = end.y - start.y;
              const chordLength = Math.sqrt(dx * dx + dy * dy);
              const arcRadius = chordLength / (2 * Math.sin(arcAngle / 2));
              
              // Calculate center of the arc
              const chordMidX = (start.x + end.x) / 2;
              const chordMidY = (start.y + end.y) / 2;
              const sagitta = arcRadius * (1 - Math.cos(arcAngle / 2));
              const perpDist = arcRadius - sagitta;
              
              // Perpendicular direction
              const perpX = -dy / chordLength;
              const perpY = dx / chordLength;
              
              // Center is offset from chord midpoint
              const sign = bulge > 0 ? 1 : -1;
              const centerX = chordMidX + sign * perpDist * perpX;
              const centerY = chordMidY + sign * perpDist * perpY;
              
              // Sample the arc
              const numSamples = Math.max(5, Math.ceil(arcAngle * 180 / Math.PI / 5));
              const startAngleRad = Math.atan2(start.y - centerY, start.x - centerX);
              
              const arcPoints: Point3D[] = [];
              for (let j = 0; j <= numSamples; j++) {
                const t = j / numSamples;
                const angle = startAngleRad + sign * t * arcAngle;
                const z = start.z + t * (end.z - start.z);
                const point: Point3D = {
                  x: centerX + arcRadius * Math.cos(angle),
                  y: centerY + arcRadius * Math.sin(angle),
                  z: z,
                };
                arcPoints.push(point);
                vertices.push(point);
                updateBounds(point.x, point.y, point.z);
              }
              
              // Create line segments between consecutive arc points
              for (let j = 0; j < arcPoints.length - 1; j++) {
                curves.push({
                  id: `seg-${segmentId++}`,
                  type: 'line',
                  start: arcPoints[j],
                  end: arcPoints[j + 1],
                });
              }
            } else {
              // Straight segment
              vertices.push(start);
              updateBounds(start.x, start.y, start.z);
              
              curves.push({
                id: `seg-${segmentId++}`,
                type: 'line',
                start,
                end,
              });
            }
          }
          if (entityVertices.length > 0) {
            const last = entityVertices[entityVertices.length - 1] as any;
            vertices.push({
              x: last.x || 0,
              y: last.y || 0,
              z: last.z || 0,
            });
            updateBounds(last.x || 0, last.y || 0, (last as any).z || 0);
          }
          break;
        }

        case 'SPLINE': {
          const controlPoints = entity.controlPoints || entity.fitPoints || entity.vertices || [];
          for (let i = 0; i < controlPoints.length - 1; i++) {
            const start: Point3D = {
              x: controlPoints[i].x || 0,
              y: controlPoints[i].y || 0,
              z: (controlPoints[i] as any).z || 0,
            };
            const end: Point3D = {
              x: controlPoints[i + 1].x || 0,
              y: controlPoints[i + 1].y || 0,
              z: (controlPoints[i + 1] as any).z || 0,
            };
            
            vertices.push(start);
            updateBounds(start.x, start.y, start.z);
            
            curves.push({
              id: `seg-${segmentId++}`,
              type: 'line',
              start,
              end,
            });
          }
          break;
        }
        
        case 'ELLIPSE': {
          // Handle ELLIPSE entities - tessellate into line segments
          const center = entity.center || { x: 0, y: 0, z: 0 };
          const majorAxis = entity.majorAxisEndPoint || entity.majorAxis || { x: 1, y: 0, z: 0 };
          const axisRatio = entity.axisRatio || entity.minorAxisRatio || 1;
          const startAngle = entity.startAngle || 0;
          const endAngle = entity.endAngle || 2 * Math.PI;
          
          // Calculate major and minor radii
          const majorRadius = Math.sqrt(majorAxis.x * majorAxis.x + majorAxis.y * majorAxis.y);
          const minorRadius = majorRadius * axisRatio;
          const rotation = Math.atan2(majorAxis.y, majorAxis.x);
          
          // Sample ellipse into points
          let arcSpan = endAngle - startAngle;
          if (arcSpan <= 0) arcSpan += 2 * Math.PI;
          const numSamples = Math.max(12, Math.ceil(arcSpan * 180 / Math.PI / 5));
          
          const ellipsePoints: Point3D[] = [];
          for (let i = 0; i <= numSamples; i++) {
            const t = i / numSamples;
            const angle = startAngle + t * arcSpan;
            
            // Parametric ellipse point
            const ex = majorRadius * Math.cos(angle);
            const ey = minorRadius * Math.sin(angle);
            
            // Rotate and translate
            const point: Point3D = {
              x: center.x + ex * Math.cos(rotation) - ey * Math.sin(rotation),
              y: center.y + ex * Math.sin(rotation) + ey * Math.cos(rotation),
              z: center.z || 0,
            };
            ellipsePoints.push(point);
            vertices.push(point);
            updateBounds(point.x, point.y, point.z);
          }
          
          // Create line segments
          for (let i = 0; i < ellipsePoints.length - 1; i++) {
            curves.push({
              id: `seg-${segmentId++}`,
              type: 'line',
              start: ellipsePoints[i],
              end: ellipsePoints[i + 1],
            });
          }
          break;
        }
        
        case '3DFACE':
        case 'SOLID': {
          // Handle 3DFACE and SOLID entities (4-point faces)
          const pts = entity.vertices || [];
          for (let i = 0; i < pts.length; i++) {
            const pt: Point3D = {
              x: pts[i].x || 0,
              y: pts[i].y || 0,
              z: pts[i].z || 0,
            };
            vertices.push(pt);
            updateBounds(pt.x, pt.y, pt.z);
          }
          
          // Create edges
          for (let i = 0; i < pts.length; i++) {
            const start: Point3D = {
              x: pts[i].x || 0,
              y: pts[i].y || 0,
              z: pts[i].z || 0,
            };
            const end: Point3D = {
              x: pts[(i + 1) % pts.length].x || 0,
              y: pts[(i + 1) % pts.length].y || 0,
              z: pts[(i + 1) % pts.length].z || 0,
            };
            curves.push({
              id: `seg-${segmentId++}`,
              type: 'line',
              start,
              end,
            });
          }
          break;
        }
        
        case 'INSERT': {
          // INSERT references a block - log for debugging
          // INSERT entity — block reference (not yet supported)
          break;
        }
        
        case '3DSOLID': {
          // 3DSOLID contains ACIS encoded geometry - we'll extract bounds from header instead
          // 3DSOLID detected — will approximate from header bounds
          break;
        }
        
        default: {
          // Log unhandled entity types for debugging
          // Unhandled entity type — skip silently
          break;
        }
      }
    }

    // If no geometry was extracted but we have 3DSOLID entities, try to extract from header bounds
    if (vertices.length === 0 && entityTypes.has('3DSOLID')) {
      // Attempt to extract geometry from 3DSOLID using header bounds
      
      // Parse header bounds directly from raw text
      const headerBounds = extractDxfHeaderBounds(text);
      
      if (headerBounds) {
        // Header bounds extracted successfully
        
        // Determine part orientation based on dimensions
        const xSpan = headerBounds.max.x - headerBounds.min.x;
        const ySpan = headerBounds.max.y - headerBounds.min.y;
        const zSpan = headerBounds.max.z - headerBounds.min.z;
        
        // Part dimensions calculated
        
        // For lathe parts, the longest axis is typically the length
        // The other two axes define the cross-section
        let partLength: number;
        let partRadius: number;
        let lengthAxis: 'x' | 'y' | 'z';
        
        if (ySpan >= xSpan && ySpan >= zSpan) {
          // Y is the length axis (most common for lathe exports)
          lengthAxis = 'y';
          partLength = ySpan;
          partRadius = Math.max(xSpan, zSpan) / 2;
        } else if (xSpan >= ySpan && xSpan >= zSpan) {
          // X is the length axis
          lengthAxis = 'x';
          partLength = xSpan;
          partRadius = Math.max(ySpan, zSpan) / 2;
        } else {
          // Z is the length axis
          lengthAxis = 'z';
          partLength = zSpan;
          partRadius = Math.max(xSpan, ySpan) / 2;
        }
        
        // Axis detection complete
        
        // Create a basic cylindrical profile from the bounds
        // This creates a simple turned profile that can be refined
        const numPoints = 50;
        for (let i = 0; i <= numPoints; i++) {
          const t = i / numPoints;
          
          let point: Point3D;
          if (lengthAxis === 'y') {
            // Y is length: profile in X-Y plane
            point = {
              x: partRadius, // Use max radius for now
              y: headerBounds.min.y + t * partLength,
              z: 0,
            };
          } else if (lengthAxis === 'x') {
            // X is length: profile in X-Y plane
            point = {
              x: headerBounds.min.x + t * partLength,
              y: partRadius,
              z: 0,
            };
          } else {
            // Z is length
            point = {
              x: partRadius,
              y: 0,
              z: headerBounds.min.z + t * partLength,
            };
          }
          
          vertices.push(point);
          updateBounds(point.x, point.y, point.z);
          
          if (i > 0) {
            curves.push({
              id: `seg-${segmentId++}`,
              type: 'line',
              start: vertices[vertices.length - 2],
              end: point,
            });
          }
        }
        
        // Profile points created from 3DSOLID bounds
      }
    }

    if (vertices.length === 0) {
      const typesList = Array.from(entityTypes).join(', ');
      throw new Error(`No geometry extracted from DXF file. File contains ${allEntities.length} entities of types: ${typesList}. Supported types: LINE, ARC, CIRCLE, LWPOLYLINE, POLYLINE, SPLINE, ELLIPSE, 3DFACE. For 3DSOLID files, try exporting as STL or creating a 2D profile.`);
    }

    const bbox = {
      min: { x: minX, y: minY, z: minZ },
      max: { x: maxX, y: maxY, z: maxZ },
    };

    // Use header units if found, otherwise guess from dimensions
    const finalUnits = detectedUnits ?? guessUnitsFromDimensions(bbox);

    return {
      sourceFile: file.name,
      fileType: 'dxf',
      vertices,
      curves,
      boundingBox: bbox,
      detectedUnits: finalUnits,
    };
  } catch (error) {
    throw new Error(`Failed to parse DXF: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Convert imported geometry to lathe toolpath
 * 
 * For lathe turning operations:
 * - X = radius at each point (from geometry Y value, which is the profile radius)
 * - Y = 0 for standard turning (or offset for special operations)
 * - Z = position along the part (from geometry Z, 0 to negative)
 * - A = rotation angle (typically 0 for turning, varies for indexing)
 * 
 * The adjusted geometry (after adjustGeometryToMachine) has:
 * - geometry.x = usually 0 for 2D profiles
 * - geometry.y = radius value (the profile shape)
 * - geometry.z = position along part (0 at spindle face, negative toward tailstock)
 */
export function geometryToToolpath(
  geometry: ImportedGeometry,
  stockDiameter: number,
  rotationStart: number = 0,
  rotationEnd: number = 360,
  rotationSteps: number = 180
): Array<{ x: number; y: number; z: number; a: number }> {
  const toolpath: Array<{ x: number; y: number; z: number; a: number }> = [];
  
  // For lathe profile turning, we extract points along the profile
  // geometry.y = radius, geometry.z = position along part
  
  // Sort vertices by Z (from Z0 toward tailstock, i.e., 0 to negative)
  const sortedVertices = [...geometry.vertices].sort((a, b) => b.z - a.z);
  
  // Remove duplicate points (within tolerance)
  const uniquePoints: Point3D[] = [];
  for (const v of sortedVertices) {
    const last = uniquePoints[uniquePoints.length - 1];
    if (!last || Math.abs(v.z - last.z) > 0.05 || Math.abs(v.y - last.y) > 0.05) {
      uniquePoints.push(v);
    }
  }
  
  // Check if this is a 4-axis operation (rotation needed) or 2-axis turning
  const is4Axis = rotationSteps > 1 && (rotationEnd - rotationStart) > 0;
  
  if (is4Axis) {
    // 4-axis: generate toolpath for each rotation step
    const aStep = (rotationEnd - rotationStart) / rotationSteps;
    
    for (let step = 0; step <= rotationSteps; step++) {
      const a = rotationStart + step * aStep;
      const aRad = (a * Math.PI) / 180;
      
      for (const vertex of uniquePoints) {
        // For 4-axis, X and Y are rotated based on angle
        const radius = Math.abs(vertex.y);
        const clampedRadius = Math.min(radius, stockDiameter / 2);
        
        toolpath.push({
          x: clampedRadius * Math.cos(aRad),
          y: clampedRadius * Math.sin(aRad),
          z: vertex.z,
          a: a
        });
      }
    }
  } else {
    // Standard 2-axis turning: X is radius, Y is 0
    for (const vertex of uniquePoints) {
      // X = radius (from geometry Y value)
      // Z = position along part (already correct from geometry)
      const radius = Math.abs(vertex.y);
      const clampedRadius = Math.min(radius, stockDiameter / 2);
      
      toolpath.push({
        x: clampedRadius,  // radius value for G-code X (will be converted to diameter in generator)
        y: 0,
        z: vertex.z,
        a: 0
      });
    }
  }

  return toolpath;
}

/**
 * Parse a DWG file and extract geometry
 * Uses the libredwg-web library for browser-based DWG parsing
 */
export async function parseDwgFile(file: File): Promise<ImportedGeometry> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const fileContent = new Uint8Array(arrayBuffer);
    
    const libredwg = await LibreDwg.create();
    
    // Try to read as DWG first, then as DXF if that fails
    let dwg = libredwg.dwg_read_data(fileContent, Dwg_File_Type.DWG);
    
    if (!dwg) {
      // Try as DXF format (some .dwg files are actually DXF)
      dwg = libredwg.dwg_read_data(fileContent, Dwg_File_Type.DXF);
    }
    
    if (!dwg) {
      throw new Error('Unable to read DWG file. The file may be corrupted or in an unsupported format. Try saving it as DXF instead.');
    }
    
    let db;
    try {
      db = libredwg.convert(dwg);
    } catch (convertError) {
      libredwg.dwg_free(dwg);
      throw new Error('Unable to convert DWG data. Try exporting the file as DXF from your CAD software.');
    }
    
    libredwg.dwg_free(dwg);
    
    if (!db) {
      throw new Error('DWG file conversion failed. Try saving as DXF format instead.');
    }
    
    const vertices: Point3D[] = [];
    const curves: ProfileSegment3D[] = [];
    
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    
    const updateBounds = (x: number, y: number, z: number) => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, z);
    };
    
    let segmentId = 0;
    
    // Process entities from the database
    // Use 'any' type as the library types don't expose all entity properties
    if (db && (db as any).entities) {
      for (const rawEntity of (db as any).entities) {
        const entity = rawEntity as any;
        const entityType = entity.type || entity.dxfName || '';
        
        if (entityType === 'LINE' || entityType === 'AcDbLine') {
          const start: Point3D = {
            x: entity.startPoint?.x || 0,
            y: entity.startPoint?.y || 0,
            z: entity.startPoint?.z || 0,
          };
          const end: Point3D = {
            x: entity.endPoint?.x || 0,
            y: entity.endPoint?.y || 0,
            z: entity.endPoint?.z || 0,
          };
          
          vertices.push(start, end);
          updateBounds(start.x, start.y, start.z);
          updateBounds(end.x, end.y, end.z);
          
          curves.push({
            id: `seg-${segmentId++}`,
            type: 'line',
            start,
            end,
          });
        } else if (entityType === 'ARC' || entityType === 'AcDbArc') {
          const center = entity.center || { x: 0, y: 0, z: 0 };
          const radius = entity.radius || 0;
          const startAngle = entity.startAngle || 0;
          const endAngle = entity.endAngle || 360;
          
          let arcSpan = endAngle - startAngle;
          if (arcSpan < 0) arcSpan += 360;
          
          const numSamples = Math.max(5, Math.ceil(arcSpan / 5));
          const arcPoints: Point3D[] = [];
          
          for (let i = 0; i <= numSamples; i++) {
            const t = i / numSamples;
            const angle = (startAngle + t * arcSpan) * Math.PI / 180;
            const point: Point3D = {
              x: center.x + radius * Math.cos(angle),
              y: center.y + radius * Math.sin(angle),
              z: center.z || 0,
            };
            arcPoints.push(point);
            vertices.push(point);
            updateBounds(point.x, point.y, point.z);
          }
          
          for (let i = 0; i < arcPoints.length - 1; i++) {
            curves.push({
              id: `seg-${segmentId++}`,
              type: 'line',
              start: arcPoints[i],
              end: arcPoints[i + 1],
            });
          }
        } else if (entityType === 'CIRCLE' || entityType === 'AcDbCircle') {
          const center = entity.center || { x: 0, y: 0, z: 0 };
          const radius = entity.radius || 0;
          
          const numPoints = 36;
          for (let i = 0; i < numPoints; i++) {
            const angle = (i / numPoints) * Math.PI * 2;
            const nextAngle = ((i + 1) / numPoints) * Math.PI * 2;
            
            const start: Point3D = {
              x: center.x + radius * Math.cos(angle),
              y: center.y + radius * Math.sin(angle),
              z: center.z || 0,
            };
            const end: Point3D = {
              x: center.x + radius * Math.cos(nextAngle),
              y: center.y + radius * Math.sin(nextAngle),
              z: center.z || 0,
            };
            
            vertices.push(start);
            updateBounds(start.x, start.y, start.z);
            
            curves.push({
              id: `seg-${segmentId++}`,
              type: 'arc_ccw',
              start,
              end,
              radius,
            });
          }
        } else if (entityType === 'LWPOLYLINE' || entityType === 'POLYLINE' || entityType === 'AcDbPolyline') {
          const points = entity.vertices || entity.points || [];
          for (let i = 0; i < points.length - 1; i++) {
            const start: Point3D = {
              x: points[i].x || 0,
              y: points[i].y || 0,
              z: points[i].z || 0,
            };
            const end: Point3D = {
              x: points[i + 1].x || 0,
              y: points[i + 1].y || 0,
              z: points[i + 1].z || 0,
            };
            
            vertices.push(start);
            updateBounds(start.x, start.y, start.z);
            
            curves.push({
              id: `seg-${segmentId++}`,
              type: 'line',
              start,
              end,
            });
          }
          if (points.length > 0) {
            const last = points[points.length - 1];
            vertices.push({
              x: last.x || 0,
              y: last.y || 0,
              z: last.z || 0,
            });
            updateBounds(last.x || 0, last.y || 0, last.z || 0);
          }
        }
      }
    }
    
    if (vertices.length === 0) {
      throw new Error('No valid geometry found in DWG file. The file may be empty or contain unsupported entity types. Try saving as DXF format instead.');
    }
    
    return {
      sourceFile: file.name,
      fileType: 'dwg',
      vertices,
      curves,
      boundingBox: {
        min: { x: minX, y: minY, z: minZ },
        max: { x: maxX, y: maxY, z: maxZ },
      },
    };
  } catch (error) {
    throw new Error(`Failed to parse DWG: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Parse an STL file and extract 3D mesh geometry
 * Uses Three.js STLLoader for browser-based parsing
 */
export async function parseStlFile(file: File): Promise<ImportedGeometry> {
  const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
  
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = (event) => {
      try {
        const loader = new STLLoader();
        const geometry = loader.parse(event.target?.result as ArrayBuffer);
        
        const positionAttr = geometry.getAttribute('position');
        const normalAttr = geometry.getAttribute('normal');
        
        if (!positionAttr) {
          throw new Error('No position data found in STL file');
        }
        
        const vertices: Point3D[] = [];
        const meshVertices: number[] = [];
        const meshNormals: number[] = [];
        
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        
        for (let i = 0; i < positionAttr.count; i++) {
          const x = positionAttr.getX(i);
          const y = positionAttr.getY(i);
          const z = positionAttr.getZ(i);
          
          meshVertices.push(x, y, z);
          
          if (normalAttr) {
            meshNormals.push(normalAttr.getX(i), normalAttr.getY(i), normalAttr.getZ(i));
          }
          
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          minZ = Math.min(minZ, z);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
          maxZ = Math.max(maxZ, z);
          
          // Keep all vertices for accurate bounding box and analysis
          // (meshData stores the full vertex array for rendering)
          if (i % 3 === 0) { // Sample every 3rd for profile (1 per triangle)
            vertices.push({ x, y, z });
          }
        }

        resolve({
          sourceFile: file.name,
          fileType: 'stl',
          vertices,
          curves: [],
          boundingBox: {
            min: { x: minX, y: minY, z: minZ },
            max: { x: maxX, y: maxY, z: maxZ },
          },
          meshData: {
            vertices: meshVertices,
            normals: meshNormals.length > 0 ? meshNormals : undefined,
          },
        });
      } catch (error) {
        reject(new Error(`Failed to parse STL: ${error instanceof Error ? error.message : 'Unknown error'}`));
      }
    };
    
    reader.onerror = () => reject(new Error('Failed to read STL file'));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Parse an OBJ file and extract 3D mesh geometry
 * Uses Three.js OBJLoader for browser-based parsing
 */
export async function parseObjFile(file: File): Promise<ImportedGeometry> {
  const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
  
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = (event) => {
      try {
        const loader = new OBJLoader();
        const object = loader.parse(event.target?.result as string);
        
        const vertices: Point3D[] = [];
        const meshVertices: number[] = [];
        const meshNormals: number[] = [];
        const meshIndices: number[] = [];
        
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        
        let vertexOffset = 0;
        
        object.traverse((child) => {
          if ((child as any).isMesh) {
            const mesh = child as any;
            const geometry = mesh.geometry;
            
            const positionAttr = geometry.getAttribute('position');
            const normalAttr = geometry.getAttribute('normal');
            const indexAttr = geometry.getIndex();
            
            if (positionAttr) {
              for (let i = 0; i < positionAttr.count; i++) {
                const x = positionAttr.getX(i);
                const y = positionAttr.getY(i);
                const z = positionAttr.getZ(i);
                
                meshVertices.push(x, y, z);
                
                if (normalAttr) {
                  meshNormals.push(normalAttr.getX(i), normalAttr.getY(i), normalAttr.getZ(i));
                }
                
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                minZ = Math.min(minZ, z);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
                maxZ = Math.max(maxZ, z);
                
                if (i % 3 === 0) {
                  vertices.push({ x, y, z });
                }
              }
              
              if (indexAttr) {
                for (let i = 0; i < indexAttr.count; i++) {
                  meshIndices.push(indexAttr.getX(i) + vertexOffset);
                }
              }
              
              vertexOffset += positionAttr.count;
            }
          }
        });
        
        if (meshVertices.length === 0) {
          throw new Error('No mesh geometry found in OBJ file');
        }
        
        resolve({
          sourceFile: file.name,
          fileType: 'obj',
          vertices,
          curves: [],
          boundingBox: {
            min: { x: minX, y: minY, z: minZ },
            max: { x: maxX, y: maxY, z: maxZ },
          },
          meshData: {
            vertices: meshVertices,
            normals: meshNormals.length > 0 ? meshNormals : undefined,
            indices: meshIndices.length > 0 ? meshIndices : undefined,
          },
        });
      } catch (error) {
        reject(new Error(`Failed to parse OBJ: ${error instanceof Error ? error.message : 'Unknown error'}`));
      }
    };
    
    reader.onerror = () => reject(new Error('Failed to read OBJ file'));
    reader.readAsText(file);
  });
}
