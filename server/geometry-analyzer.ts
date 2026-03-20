/**
 * Geometry Analyzer — Auto-detect cutting operations from imported geometry
 *
 * Analyzes DXF/STL/OBJ geometry to determine:
 * 1. Part shape classification (axisymmetric, prismatic, freeform)
 * 2. Feature detection (holes, grooves, threads, flats, relief)
 * 3. DXF layer name parsing for operation intent
 * 4. Auto-generated operation sequence with tool selection
 * 5. Feed/speed recommendations for wood materials
 *
 * The goal is zero-touch: import a file → get a complete operation list.
 */

import type {
  Point3D, ImportedGeometry, ProfileSegment3D, Operation, OperationType,
  MachineStock, DrillingParams, GroovingParams, HolePattern
} from '@shared/schema';

// ============================================================
// TYPES
// ============================================================

export interface AnalysisResult {
  /** Detected part shape */
  shape: 'axisymmetric' | 'prismatic' | 'freeform' | 'unknown';
  /** Confidence in shape detection (0-1) */
  shapeConfidence: number;
  /** Recommended stock dimensions */
  recommendedStock: MachineStock;
  /** Auto-generated operation list in execution order */
  suggestedOperations: Operation[];
  /** Detected features */
  features: DetectedFeature[];
  /** Axis mapping used */
  axisMapping: { length: 'x' | 'y' | 'z'; radius: 'x' | 'y' | 'z' };
  /** Warnings about the geometry */
  warnings: string[];
  /** Estimated cycle time in seconds */
  estimatedCycleTime: number;
}

export interface DetectedFeature {
  type: 'profile' | 'hole' | 'groove' | 'flat' | 'thread' | 'relief' | 'taper' | 'bead' | 'cove';
  confidence: number;
  position: { z: number; angle?: number };
  dimensions: Record<string, number>;
  description: string;
  /** Which operation type this feature maps to */
  operationType: OperationType;
}

/** Wood material feed/speed database */
interface WoodCuttingData {
  spindleRPM: { turning: number; milling: number; drilling: number; sanding: number };
  feedRate: { turning: number; milling: number; drilling: number; sanding: number; roughing: number };
  depthOfCut: { roughing: number; finishing: number };
}

const WOOD_CUTTING_DATA: Record<string, WoodCuttingData> = {
  oak: {
    spindleRPM: { turning: 1800, milling: 14000, drilling: 1200, sanding: 2400 },
    feedRate: { turning: 180, milling: 400, drilling: 80, sanding: 1500, roughing: 250 },
    depthOfCut: { roughing: 3, finishing: 0.5 },
  },
  maple: {
    spindleRPM: { turning: 2000, milling: 15000, drilling: 1400, sanding: 2600 },
    feedRate: { turning: 200, milling: 450, drilling: 90, sanding: 1500, roughing: 280 },
    depthOfCut: { roughing: 2.5, finishing: 0.4 },
  },
  walnut: {
    spindleRPM: { turning: 2100, milling: 14000, drilling: 1300, sanding: 2400 },
    feedRate: { turning: 200, milling: 420, drilling: 85, sanding: 1500, roughing: 260 },
    depthOfCut: { roughing: 3, finishing: 0.5 },
  },
  pine: {
    spindleRPM: { turning: 2400, milling: 16000, drilling: 1500, sanding: 2800 },
    feedRate: { turning: 250, milling: 500, drilling: 100, sanding: 1800, roughing: 350 },
    depthOfCut: { roughing: 4, finishing: 0.5 },
  },
  cherry: {
    spindleRPM: { turning: 2000, milling: 14000, drilling: 1300, sanding: 2400 },
    feedRate: { turning: 200, milling: 420, drilling: 85, sanding: 1500, roughing: 270 },
    depthOfCut: { roughing: 3, finishing: 0.5 },
  },
};

const DEFAULT_WOOD = WOOD_CUTTING_DATA.oak;

// ============================================================
// MAIN ANALYZER
// ============================================================

export function analyzeGeometry(
  geometry: ImportedGeometry,
  material: string = 'oak'
): AnalysisResult {
  const woodData = WOOD_CUTTING_DATA[material] || DEFAULT_WOOD;
  const warnings: string[] = [];
  const features: DetectedFeature[] = [];

  // Step 1: Determine axis mapping
  const bbox = geometry.boundingBox;
  const spans = {
    x: Math.abs(bbox.max.x - bbox.min.x),
    y: Math.abs(bbox.max.y - bbox.min.y),
    z: Math.abs(bbox.max.z - bbox.min.z),
  };

  const axisMapping = detectAxisMapping(spans);

  // Step 2: Classify shape
  const shapeResult = classifyShape(geometry, axisMapping);

  // Step 3: Detect features from geometry
  const profileFeatures = detectProfileFeatures(geometry, axisMapping);
  features.push(...profileFeatures);

  // Step 4: Detect features from DXF layer names (if DXF)
  if (geometry.fileType === 'dxf' && geometry.curves.length > 0) {
    const layerFeatures = detectFeaturesFromLayers(geometry);
    features.push(...layerFeatures);
  }

  // Step 5: Detect holes
  const holeFeatures = detectHoles(geometry, axisMapping);
  features.push(...holeFeatures);

  // Step 6: Calculate recommended stock
  const lengthSpan = spans[axisMapping.length];
  const radiusSpan = Math.max(
    spans[axisMapping.radius],
    spans[Object.keys(spans).find(k => k !== axisMapping.length && k !== axisMapping.radius) as 'x' | 'y' | 'z']
  );

  const recommendedStock: MachineStock = {
    type: shapeResult.shape === 'axisymmetric' ? 'round' : 'square',
    diameter: Math.ceil(radiusSpan + 10), // 5mm margin per side
    length: Math.ceil(lengthSpan + 20),   // 10mm margin per end
    zOffset: 0,
    material,
    width: shapeResult.shape !== 'axisymmetric' ? Math.ceil(radiusSpan + 10) : undefined,
    height: shapeResult.shape !== 'axisymmetric' ? Math.ceil(
      spans[Object.keys(spans).find(k => k !== axisMapping.length && k !== axisMapping.radius) as 'x' | 'y' | 'z'] + 10
    ) : undefined,
  };

  // Step 7: Auto-generate operations
  const suggestedOperations = generateOperationSequence(
    shapeResult, features, recommendedStock, woodData, warnings
  );

  // Step 8: Estimate cycle time
  const estimatedCycleTime = estimateCycleTime(suggestedOperations, recommendedStock);

  // Validation warnings
  if (radiusSpan > 300) {
    warnings.push(`Part diameter (${radiusSpan.toFixed(0)}mm) exceeds machine max (300mm)`);
  }
  if (lengthSpan > 1500) {
    warnings.push(`Part length (${lengthSpan.toFixed(0)}mm) exceeds machine max (1500mm)`);
  }
  if (shapeResult.shapeConfidence < 0.5) {
    warnings.push('Low confidence in shape detection — review axis orientation');
  }

  return {
    shape: shapeResult.shape,
    shapeConfidence: shapeResult.shapeConfidence,
    recommendedStock,
    suggestedOperations,
    features,
    axisMapping,
    warnings,
    estimatedCycleTime,
  };
}

// ============================================================
// AXIS MAPPING
// ============================================================

function detectAxisMapping(spans: { x: number; y: number; z: number }): { length: 'x' | 'y' | 'z'; radius: 'x' | 'y' | 'z' } {
  // The longest axis is typically the workpiece length (Z on the lathe)
  // The two shorter axes are radial (X/Y)
  const sorted = Object.entries(spans).sort((a, b) => b[1] - a[1]) as [('x' | 'y' | 'z'), number][];
  return {
    length: sorted[0][0],
    radius: sorted[1][0],
  };
}

// ============================================================
// SHAPE CLASSIFICATION
// ============================================================

function classifyShape(
  geometry: ImportedGeometry,
  axisMapping: { length: 'x' | 'y' | 'z'; radius: 'x' | 'y' | 'z' }
): { shape: AnalysisResult['shape']; shapeConfidence: number } {
  const vertices = geometry.vertices;
  if (vertices.length < 3) {
    return { shape: 'unknown', shapeConfidence: 0 };
  }

  // Test for axisymmetry: sample points and check if they're roughly
  // equidistant from the center axis at each length position
  const lengthKey = axisMapping.length;
  const otherKeys = (['x', 'y', 'z'] as const).filter(k => k !== lengthKey);

  // Group vertices by length position (binned)
  const bins = new Map<number, number[]>();
  for (const v of vertices) {
    const lengthPos = Math.round(v[lengthKey] * 2) / 2; // 0.5mm bins
    const radius = Math.sqrt(v[otherKeys[0]] ** 2 + v[otherKeys[1]] ** 2);
    if (!bins.has(lengthPos)) bins.set(lengthPos, []);
    bins.get(lengthPos)!.push(radius);
  }

  // Check radius variance at each length position
  let symmetricBins = 0;
  let totalBins = 0;
  bins.forEach((radii) => {
    if (radii.length < 2) return;
    totalBins++;
    const mean = radii.reduce((a: number, b: number) => a + b, 0) / radii.length;
    const variance = radii.reduce((a: number, r: number) => a + (r - mean) ** 2, 0) / radii.length;
    const cv = Math.sqrt(variance) / (mean || 1); // Coefficient of variation
    if (cv < 0.15) symmetricBins++; // Less than 15% variation = symmetric
  });

  const symmetryRatio = totalBins > 0 ? symmetricBins / totalBins : 0;

  if (symmetryRatio > 0.7) {
    return { shape: 'axisymmetric', shapeConfidence: symmetryRatio };
  }

  // Check for prismatic (flat faces)
  // If most points lie on a few distinct planes perpendicular to radial axes
  if (symmetryRatio < 0.3) {
    // Check if vertices cluster on flat planes
    const flatCount = countFlatFaces(vertices, otherKeys);
    if (flatCount >= 2) {
      return { shape: 'prismatic', shapeConfidence: 0.6 + flatCount * 0.05 };
    }
  }

  if (geometry.meshData) {
    return { shape: 'freeform', shapeConfidence: 0.5 };
  }

  return { shape: 'axisymmetric', shapeConfidence: 0.4 }; // Default assumption for lathe
}

function countFlatFaces(vertices: Point3D[], axes: readonly ('x' | 'y' | 'z')[]): number {
  let flatCount = 0;
  for (const axis of axes) {
    const values = vertices.map(v => v[axis]);
    const uniqueRounded = new Set(values.map(v => Math.round(v * 10) / 10));
    // If most points cluster at a few values, there are flat faces
    if (uniqueRounded.size < Math.max(5, vertices.length * 0.1)) {
      flatCount++;
    }
  }
  return flatCount;
}

// ============================================================
// PROFILE FEATURE DETECTION
// ============================================================

function detectProfileFeatures(
  geometry: ImportedGeometry,
  axisMapping: { length: 'x' | 'y' | 'z'; radius: 'x' | 'y' | 'z' }
): DetectedFeature[] {
  const features: DetectedFeature[] = [];
  const vertices = geometry.vertices;
  if (vertices.length < 4) return features;

  const lengthKey = axisMapping.length;
  const otherKeys = (['x', 'y', 'z'] as const).filter(k => k !== lengthKey);

  // Build radius profile along length
  const profile = new Map<number, number>();
  for (const v of vertices) {
    const z = Math.round(v[lengthKey] * 2) / 2;
    const r = Math.sqrt(v[otherKeys[0]] ** 2 + v[otherKeys[1]] ** 2);
    profile.set(z, Math.max(profile.get(z) || 0, r));
  }

  const sortedProfile = Array.from(profile.entries()).sort((a, b) => a[0] - b[0]);
  if (sortedProfile.length < 3) return features;

  // Detect grooves: significant radius decrease then increase
  for (let i = 1; i < sortedProfile.length - 1; i++) {
    const prev = sortedProfile[i - 1][1];
    const curr = sortedProfile[i][1];
    const next = sortedProfile[i + 1][1];
    const z = sortedProfile[i][0];

    // Groove: dip of >2mm with recovery
    if (prev - curr > 2 && next - curr > 2) {
      features.push({
        type: 'groove',
        confidence: Math.min(0.9, (prev - curr + next - curr) / 10),
        position: { z },
        dimensions: { depth: (prev + next) / 2 - curr, width: Math.abs(sortedProfile[i + 1][0] - sortedProfile[i - 1][0]) },
        description: `Groove at Z=${z.toFixed(1)}mm, depth ${((prev + next) / 2 - curr).toFixed(1)}mm`,
        operationType: 'grooving',
      });
    }

    // Bead: bump of >2mm
    if (curr - prev > 2 && curr - next > 2) {
      features.push({
        type: 'bead',
        confidence: 0.7,
        position: { z },
        dimensions: { height: curr - Math.min(prev, next) },
        description: `Bead at Z=${z.toFixed(1)}mm`,
        operationType: 'turning',
      });
    }

    // Taper: consistent radius change over a section
    if (i < sortedProfile.length - 3) {
      const slope1 = sortedProfile[i][1] - sortedProfile[i - 1][1];
      const slope2 = sortedProfile[i + 1][1] - sortedProfile[i][1];
      const slope3 = sortedProfile[i + 2][1] - sortedProfile[i + 1][1];
      if (Math.abs(slope1 - slope2) < 0.5 && Math.abs(slope2 - slope3) < 0.5 && Math.abs(slope1) > 0.3) {
        features.push({
          type: 'taper',
          confidence: 0.6,
          position: { z },
          dimensions: { angle: Math.atan2(slope1, sortedProfile[i][0] - sortedProfile[i - 1][0]) * 180 / Math.PI },
          description: `Taper starting at Z=${z.toFixed(1)}mm`,
          operationType: 'turning',
        });
      }
    }
  }

  // Always add the main profile as a turning feature
  const maxRadius = Math.max(...sortedProfile.map(p => p[1]));
  const minRadius = Math.min(...sortedProfile.map(p => p[1]));
  if (maxRadius - minRadius > 1) {
    features.push({
      type: 'profile',
      confidence: 0.9,
      position: { z: sortedProfile[0][0] },
      dimensions: {
        maxRadius,
        minRadius,
        length: sortedProfile[sortedProfile.length - 1][0] - sortedProfile[0][0],
      },
      description: `Profile: R${minRadius.toFixed(1)}–${maxRadius.toFixed(1)}mm over ${(sortedProfile[sortedProfile.length - 1][0] - sortedProfile[0][0]).toFixed(0)}mm`,
      operationType: 'turning',
    });
  }

  return features;
}

// ============================================================
// HOLE DETECTION
// ============================================================

function detectHoles(
  geometry: ImportedGeometry,
  axisMapping: { length: 'x' | 'y' | 'z'; radius: 'x' | 'y' | 'z' }
): DetectedFeature[] {
  const features: DetectedFeature[] = [];

  // Look for circles in curves (from DXF)
  for (const curve of geometry.curves) {
    if (curve.type === 'arc_cw' || curve.type === 'arc_ccw') {
      if (curve.radius && curve.radius < 20) { // Small arcs likely holes
        // Check if it's a full circle (start ≈ end)
        const dist = Math.sqrt(
          (curve.start.x - curve.end.x) ** 2 +
          (curve.start.y - curve.end.y) ** 2 +
          (curve.start.z - curve.end.z) ** 2
        );
        if (dist < 1) { // Closed circle
          const center = curve.center || {
            x: (curve.start.x + curve.end.x) / 2,
            y: (curve.start.y + curve.end.y) / 2,
            z: (curve.start.z + curve.end.z) / 2,
          };
          features.push({
            type: 'hole',
            confidence: 0.85,
            position: { z: center[axisMapping.length] },
            dimensions: { diameter: curve.radius * 2, depth: 10 }, // Assume 10mm depth
            description: `Hole ⌀${(curve.radius * 2).toFixed(1)}mm at Z=${center[axisMapping.length].toFixed(1)}mm`,
            operationType: 'drilling',
          });
        }
      }
    }
  }

  return features;
}

// ============================================================
// DXF LAYER NAME PARSING
// ============================================================

function detectFeaturesFromLayers(geometry: ImportedGeometry): DetectedFeature[] {
  const features: DetectedFeature[] = [];
  const layerNames = new Set<string>();

  // Collect layer names from curves (ProfileSegment3D doesn't have layer,
  // but we can infer from curve IDs if they encode layer info)
  // For now, parse common Catek/RouterCIM layer naming conventions
  for (const curve of geometry.curves) {
    const id = curve.id.toUpperCase();

    if (id.includes('OUTSIDE') || id.includes('PROFILE') || id.includes('CONTOUR')) {
      features.push({
        type: 'profile',
        confidence: 0.95,
        position: { z: curve.start.z },
        dimensions: {},
        description: `Outside profile from layer "${curve.id}"`,
        operationType: 'turning',
      });
    }
    if (id.includes('GROOVE') || id.includes('CHANNEL') || id.includes('SLOT')) {
      features.push({
        type: 'groove',
        confidence: 0.9,
        position: { z: curve.start.z },
        dimensions: { width: 3, depth: 5 },
        description: `Groove from layer "${curve.id}"`,
        operationType: 'grooving',
      });
    }
    if (id.includes('HOLE') || id.includes('DRILL')) {
      const diamMatch = id.match(/(\d+\.?\d*)/);
      features.push({
        type: 'hole',
        confidence: 0.9,
        position: { z: curve.start.z },
        dimensions: { diameter: diamMatch ? parseFloat(diamMatch[1]) : 10, depth: 10 },
        description: `Hole from layer "${curve.id}"`,
        operationType: 'drilling',
      });
    }
    if (id.includes('THREAD')) {
      const pitchMatch = id.match(/(\d+\.?\d*)/);
      features.push({
        type: 'thread',
        confidence: 0.85,
        position: { z: curve.start.z },
        dimensions: { pitch: pitchMatch ? parseFloat(pitchMatch[1]) : 2 },
        description: `Thread from layer "${curve.id}"`,
        operationType: 'threading',
      });
    }
    if (id.includes('ENGRAV') || id.includes('TEXT') || id.includes('LOGO')) {
      features.push({
        type: 'relief',
        confidence: 0.85,
        position: { z: curve.start.z },
        dimensions: { depth: 1 },
        description: `Engraving from layer "${curve.id}"`,
        operationType: 'engraving',
      });
    }
    if (id.includes('FLAT') || id.includes('PLANE') || id.includes('MILL')) {
      features.push({
        type: 'flat',
        confidence: 0.85,
        position: { z: curve.start.z },
        dimensions: {},
        description: `Flat face from layer "${curve.id}"`,
        operationType: 'milling',
      });
    }
  }

  return features;
}

// ============================================================
// OPERATION SEQUENCE GENERATION
// ============================================================

let opIdCounter = 0;
function nextOpId(): string {
  return `auto_${++opIdCounter}_${Date.now().toString(36)}`;
}

function generateOperationSequence(
  shapeResult: { shape: AnalysisResult['shape']; shapeConfidence: number },
  features: DetectedFeature[],
  stock: MachineStock,
  woodData: WoodCuttingData,
  warnings: string[]
): Operation[] {
  const ops: Operation[] = [];
  const stockRadius = stock.diameter / 2;

  // 1. ROUGHING (always first for turned parts)
  if (shapeResult.shape === 'axisymmetric' || shapeResult.shape === 'unknown') {
    ops.push({
      id: nextOpId(),
      toolNumber: 1,
      type: 'roughing',
      rotationMode: 'continuous',
      spindleId: 'main',
      params: {
        feedRate: woodData.feedRate.roughing,
        rapidFeedRate: 5000,
        spindleSpeed: woodData.spindleRPM.turning,
        depthOfCut: woodData.depthOfCut.roughing,
      },
    });
  }

  // 2. TURNING / FINISHING (profile following)
  const hasProfile = features.some(f => f.type === 'profile');
  if (hasProfile || shapeResult.shape === 'axisymmetric') {
    ops.push({
      id: nextOpId(),
      toolNumber: 1,
      type: 'turning',
      rotationMode: 'continuous',
      spindleId: 'main',
      params: {
        feedRate: woodData.feedRate.turning,
        rapidFeedRate: 5000,
        spindleSpeed: woodData.spindleRPM.turning,
        depthOfCut: woodData.depthOfCut.finishing,
      },
    });
  }

  // 3. GROOVING (if detected)
  const grooves = features.filter(f => f.type === 'groove');
  if (grooves.length > 0) {
    ops.push({
      id: nextOpId(),
      toolNumber: 7,
      type: 'grooving',
      rotationMode: 'continuous',
      spindleId: 'main',
      params: {
        feedRate: 50,
        rapidFeedRate: 5000,
        spindleSpeed: woodData.spindleRPM.turning,
        grooving: {
          grooveWidth: grooves[0].dimensions.width || 3,
          grooveDepth: grooves[0].dimensions.depth || 5,
          grooveProfile: 'square',
          grooveCount: grooves.length,
          zPositions: grooves.map(g => g.position.z),
        },
      },
    });
  }

  // 4. DRILLING (if holes detected)
  const holes = features.filter(f => f.type === 'hole');
  if (holes.length > 0) {
    ops.push({
      id: nextOpId(),
      toolNumber: 4,
      type: 'drilling',
      rotationMode: 'static',
      spindleId: 'milling1',
      params: {
        feedRate: woodData.feedRate.drilling,
        rapidFeedRate: 5000,
        spindleSpeed: woodData.spindleRPM.drilling,
        drilling: {
          holeDepth: holes[0].dimensions.depth || 10,
          peckDepth: 3,
          retractHeight: 2,
          drillCycle: 'peck',
          throughHole: false,
          holePattern: {
            type: holes.length > 1 ? 'indexed' : 'single',
            positions: holes.map(h => ({ x: 0, y: 0, z: h.position.z })),
            indexAngles: holes.length > 1 ? holes.map(h => h.position.angle || 0) : undefined,
          },
        },
      },
    });
  }

  // 5. INDEXED MILLING (if flats detected or prismatic shape)
  const flats = features.filter(f => f.type === 'flat');
  if (flats.length > 0 || shapeResult.shape === 'prismatic') {
    const indexCount = flats.length || 4;
    ops.push({
      id: nextOpId(),
      toolNumber: 6,
      type: 'milling',
      rotationMode: 'indexed',
      spindleId: 'milling1',
      params: {
        feedRate: woodData.feedRate.milling,
        rapidFeedRate: 5000,
        spindleSpeed: woodData.spindleRPM.milling,
        depthOfCut: 2,
        indexCount,
        indexAngle: 360 / indexCount,
      },
    });
  }

  // 6. THREADING (if detected)
  const threads = features.filter(f => f.type === 'thread');
  if (threads.length > 0) {
    ops.push({
      id: nextOpId(),
      toolNumber: 10,
      type: 'threading',
      rotationMode: 'continuous',
      spindleId: 'main',
      params: {
        feedRate: 100,
        rapidFeedRate: 5000,
        spindleSpeed: 300,
        threading: {
          pitch: threads[0].dimensions.pitch || 2,
          threadDepth: 1.3,
          threadType: 'external',
          threadForm: 'v60',
          startZ: 0,
          endZ: -50,
          infeedAngle: 29.5,
          springPasses: 2,
          firstCutDepth: 0.3,
          minCutDepth: 0.05,
        },
      },
    });
  }

  // 7. ENGRAVING (if detected)
  const engravings = features.filter(f => f.operationType === 'engraving');
  if (engravings.length > 0) {
    ops.push({
      id: nextOpId(),
      toolNumber: 8,
      type: 'engraving',
      rotationMode: 'static',
      spindleId: 'milling1',
      params: {
        feedRate: 300,
        rapidFeedRate: 5000,
        spindleSpeed: 15000,
        engraving: {
          engravingDepth: 1,
          surfaceAngle: 0,
          position: { z: engravings[0].position.z, offset: 0 },
        },
      },
    });
  }

  // 8. 3D CARVING (for freeform shapes with mesh data)
  if (shapeResult.shape === 'freeform') {
    ops.push({
      id: nextOpId(),
      toolNumber: 9,
      type: 'carving_3d',
      rotationMode: 'simultaneous',
      spindleId: 'milling1',
      params: {
        feedRate: 200,
        rapidFeedRate: 5000,
        spindleSpeed: 12000,
        carving3d: {
          finishingStrategy: 'raster',
          scallopHeight: 0.1,
          stepdown: 3,
          boundaryOffset: 2,
        },
      },
    });
  }

  // 9. SANDING (always last for turned parts)
  if (shapeResult.shape === 'axisymmetric' || shapeResult.shape === 'unknown') {
    ops.push({
      id: nextOpId(),
      toolNumber: 3,
      type: 'sanding',
      rotationMode: 'continuous',
      spindleId: 'sanding',
      params: {
        feedRate: woodData.feedRate.sanding,
        rapidFeedRate: 5000,
        spindleSpeed: woodData.spindleRPM.sanding,
        paddleOffset: 1.0,
      },
    });
  }

  return ops;
}

// ============================================================
// CYCLE TIME ESTIMATION
// ============================================================

function estimateCycleTime(operations: Operation[], stock: MachineStock): number {
  let totalSeconds = 0;
  const stockLength = stock.length;
  const stockDiameter = stock.diameter;

  for (const op of operations) {
    const feed = op.params.feedRate || 200; // mm/min

    switch (op.type) {
      case 'roughing': {
        // Estimate: multiple passes along stock length
        const passes = Math.ceil(stockDiameter / 2 / (op.params.depthOfCut || 3));
        totalSeconds += (stockLength / feed) * 60 * passes;
        totalSeconds += passes * 3; // Rapid repositioning
        break;
      }
      case 'turning':
      case 'finishing': {
        totalSeconds += (stockLength / feed) * 60;
        totalSeconds += 5; // Tool change
        break;
      }
      case 'sanding': {
        totalSeconds += (stockLength / feed) * 60 * 2; // 2 passes
        totalSeconds += 5;
        break;
      }
      case 'drilling': {
        const holes = op.params.drilling?.holePattern?.positions?.length || 1;
        const depth = op.params.drilling?.holeDepth || 10;
        totalSeconds += holes * (depth / feed) * 60 * 3; // Peck drilling = ~3x depth time
        totalSeconds += holes * 3; // Positioning
        break;
      }
      case 'grooving': {
        const count = op.params.grooving?.grooveCount || 1;
        totalSeconds += count * 10; // ~10s per groove
        break;
      }
      case 'threading': {
        totalSeconds += 60; // ~1min for threading
        break;
      }
      case 'milling': {
        const sides = op.params.indexCount || 4;
        const passes = Math.ceil(stockDiameter / 4 / (op.params.depthOfCut || 2));
        totalSeconds += sides * passes * (stockLength / feed) * 60;
        break;
      }
      case 'carving_3d': {
        // 3D carving is slow
        totalSeconds += stockLength * stockDiameter * 0.1; // Very rough estimate
        break;
      }
      default:
        totalSeconds += 30;
    }
  }

  // Add load/clamp/unload time
  totalSeconds += 15;

  return Math.round(totalSeconds);
}
