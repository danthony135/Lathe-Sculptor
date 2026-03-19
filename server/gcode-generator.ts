import { ProjectData, ToolpathPoint, Operation } from "@shared/schema";

/**
 * Catek CNC 7-in-1 Wood Lathe G-Code Generator
 * 
 * Format matches actual Catek machine requirements:
 * - X axis: Diameter mode (not radius)
 * - Z axis: Z0 at spindle face, negative toward tailstock
 * - Tool format: Ttttt (e.g., T0909)
 * - Simple, minimal formatting
 * 
 * Supports multiple operation types:
 * - Continuous rotation (turning/sanding)
 * - Indexed rotation (multi-sided milling)
 * - Static (drilling/routing without rotation)
 */

interface GCodeGeneratorOptions {
  projectName?: string;
  includeComments?: boolean;
  stockLength?: number;
  cuttingFeed?: number;
  spindleRPM?: number;
  safeX?: number;
  safeY?: number;
  roughingDiameter?: number;
  singleRoughingPass?: boolean;
  // Tool numbers (default to standard Catek setup)
  knifeToolNumber?: number;      // Turning knife - default 4 (T0404)
  sandingToolNumber?: number;    // Sanding paddles - default 3 (T0303)
  paddleOffset?: number;         // How much deeper sanding paddles cut into part (mm)
  sandingRPM?: number;           // Sanding spindle speed
  sandingFeed?: number;          // Sanding feed rate
}

export function generateGCode(
  data: ProjectData, 
  options: GCodeGeneratorOptions = {}
): string {
  const {
    projectName = "Untitled",
    includeComments = false,
    stockLength = data.stock?.length || 910,
    cuttingFeed = 200,
    spindleRPM = 2100,
    safeX = 100,
    safeY = 75,
    roughingDiameter = data.stock?.diameter || 110,
    singleRoughingPass = true,
    knifeToolNumber = 4,
    sandingToolNumber = 3,
    paddleOffset = 1.0,  // Default 1mm deeper than profile
    sandingRPM = 2400,
    sandingFeed = 1500
  } = options;
  
  // Format tool number as Ttttt (e.g., 4 -> T0404)
  const formatTool = (n: number) => `T0${n}0${n}`;

  if (!data || !data.toolpath || data.toolpath.length === 0) {
    return "No toolpath data";
  }

  const gcode: string[] = [];
  const stockDiameter = data.stock?.diameter || 100;
  const quantity = data.quantity || 1;  // Number of pieces to cut
  
  // Check if this is purely an indexed milling job (no continuous turning/sanding)
  const hasContinuousOps = data.operations?.some(op => 
    op.rotationMode === 'continuous' || 
    op.type === 'turning' || 
    op.type === 'sanding'
  );
  const hasIndexedOps = data.operations?.some(op => op.rotationMode === 'indexed');
  
  // If only indexed operations (no turning/sanding), use indexed milling workflow
  if (hasIndexedOps && !hasContinuousOps) {
    return generateIndexedMillingJob(data, { projectName, stockLength, safeX, safeY });
  }
  // Mixed operations: continue with standard turning workflow, indexed ops will be added separately
  
  // Project name header
  gcode.push(projectName);
  gcode.push('');

  // === INITIALIZATION ===
  // Tool list at top (only once at start)
  gcode.push('T0909');
  gcode.push('T0202');
  gcode.push('');
  gcode.push('T0707');
  gcode.push('');

  // === QUANTITY LOOP - Repeat cutting cycle for each piece ===
  for (let pieceNum = 1; pieceNum <= quantity; pieceNum++) {
    // Add piece number comment for multi-piece jobs
    if (quantity > 1) {
      gcode.push(`(PIECE ${pieceNum} OF ${quantity})`);
      gcode.push('');
    }
    
    // === LOAD AND CLAMP ===
    // Loader sequence - load workpiece
    gcode.push('M69');  // Release loader
    gcode.push('M70');  // Loader sequence start
    gcode.push('M71');  // Loader position
    gcode.push('M72');  // Loader complete
    gcode.push('');
    
    // Clamp workpiece
    gcode.push('M68');  // Clamp workpiece
    gcode.push('');

  // === ROUGHING PASS ===
  // Find the minimum profile diameter to know how deep to rough
  const getRadius = (p: ToolpathPoint): number => {
    if (p.y === 0 || Math.abs(p.y) < 0.001) {
      return Math.abs(p.x);
    } else {
      return Math.sqrt(p.x * p.x + p.y * p.y);
    }
  };
  const minProfileRadius = Math.min(...data.toolpath.map(p => getRadius(p)));
  const minProfileDiameter = minProfileRadius * 2;
  
  // Roughing removes material from stock diameter down to just above minimum profile
  // Leave 2mm for finish pass
  const roughTargetDiameter = minProfileDiameter + 2;
  
  // Get roughing/turning settings from operations if available
  const roughingOp = data.operations?.find(op => op.type === 'roughing' || op.type === 'turning');
  const actualSpindleRPM = roughingOp?.params?.spindleSpeed ?? spindleRPM;
  const actualCuttingFeed = roughingOp?.params?.feedRate ?? cuttingFeed;
  
  gcode.push('G0Z0');
  gcode.push(`G0X${safeX} Z0 Y${safeY.toFixed(1)}`);
  gcode.push(`M03 S${actualSpindleRPM}`);
  gcode.push('M76');
  gcode.push('');

  if (singleRoughingPass) {
    // Single roughing pass - cut directly to target diameter
    gcode.push(`G0X${roughTargetDiameter.toFixed(3)} Z0`);
    gcode.push(`G1Z-${stockLength.toFixed(1)} F${actualCuttingFeed.toFixed(0)}`);
    gcode.push(`G0X${safeX}`);
  } else {
    // Multiple roughing passes from stock diameter down to rough target
    const depthPerPass = 3; // 3mm radial depth per roughing pass
    let currentDiameter = stockDiameter;
    while (currentDiameter > roughTargetDiameter) {
      currentDiameter = Math.max(currentDiameter - depthPerPass * 2, roughTargetDiameter);
      
      // Rapid to Z0 at safe X
      gcode.push(`G0X${safeX} Z0`);
      // Rapid to cutting diameter at Z0
      gcode.push(`G0X${currentDiameter.toFixed(3)} Z0`);
      // Feed along Z to remove material
      gcode.push(`G1Z-${stockLength.toFixed(1)} F${actualCuttingFeed.toFixed(0)}`);
      // Retract
      gcode.push(`G0X${safeX}`);
    }
  }
  gcode.push(`G0 X${safeX} Z0`);
  gcode.push('');

  // === KNIFE/TURNING PASS (Tool 4) ===
  // Tool change to turning knife (no T0707 here - that drops piece, only at end)
  gcode.push(formatTool(knifeToolNumber));
  gcode.push('');

  gcode.push(`G0 X${safeX} Z0`);
  // Spindle already running from roughing pass, no need for M03 again
  gcode.push('G0Z0');
  gcode.push(`G0X${safeX} Z0`);

  // Generate profile from toolpath for knife
  const profileGcode = generateProfileFromToolpath(data.toolpath, cuttingFeed, stockLength, stockDiameter, 0);
  gcode.push(...profileGcode);

  // === SANDING PASS ===
  // Check if sanding operation is enabled (look in operations or use default)
  const hasSanding = data.operations?.some(op => op.type === 'sanding') ?? true;
  
  if (hasSanding) {
    // Get sanding settings from operations or use defaults
    const sandingOp = data.operations?.find(op => op.type === 'sanding');
    const actualPaddleOffset = sandingOp?.params?.paddleOffset ?? paddleOffset;
    const actualSandingRPM = sandingOp?.params?.spindleSpeed ?? sandingRPM;
    const actualSandingFeed = sandingOp?.params?.feedRate ?? sandingFeed;
    const actualSandingTool = sandingOp?.toolNumber ?? sandingToolNumber;
    
    // NO retract to Z0 here - sanding starts from where knife ended (at tailstock end)
    // Tool change: retract knife first, then bring in sanding tool
    // NO T0707 here - that would drop the piece!
    gcode.push('');
    gcode.push(formatTool(knifeToolNumber));  // Retract knife (T0404)
    gcode.push('');
    gcode.push(formatTool(actualSandingTool));  // Bring in sanding (T0303)
    gcode.push('');

    // No need for M03 again - spindle already running
    // Sanding runs in REVERSE from end of profile back to Z0
    // Tool is already at the tailstock end from knife pass - no need to return to Z0
    
    // Generate sanding profile in REVERSE - same toolpath but with offset (deeper into part)
    // Offset is subtracted from diameter (makes cut deeper)
    const sandingGcode = generateProfileFromToolpath(
      data.toolpath, 
      actualSandingFeed, 
      stockLength, 
      stockDiameter, 
      actualPaddleOffset * 2,  // Convert radius offset to diameter
      true  // REVERSE direction - start from end, work back to Z0
    );
    gcode.push(...sandingGcode);

    // Retract after sanding completes at Z0
    gcode.push('');
    gcode.push(`G0X${safeX} Z0`);
  } else {
    // No sanding - retract knife after profile pass
    gcode.push('');
    gcode.push('G0Z0');
    gcode.push(`G0X${safeX} Z0`);
  }

    // === END OF PIECE - Drop and prepare for next ===
    gcode.push('');
    
    // Stop spindle
    gcode.push('M05');
    gcode.push('M77');  // Auxiliary OFF (dust collection)
    
    // Retract sanding tool, then drop piece with T0707
    gcode.push(formatTool(sandingToolNumber));  // Retract sanding (T0303)
    gcode.push('');
    gcode.push('T0707');  // Drop piece
    gcode.push('');
    gcode.push('T0202');
    gcode.push('');
    
  }  // End of quantity loop
  
  // Program end (after all pieces complete)
  gcode.push('M30');

  return gcode.join('\n');
}

function generateProfileFromToolpath(
  toolpath: ToolpathPoint[],
  feedRate: number,
  stockLength: number,
  stockDiameter: number,
  diameterOffset: number = 0,  // Offset to apply to all diameters (negative = deeper cut)
  reverse: boolean = false  // If true, traverse from end of profile back to Z0
): string[] {
  const gcode: string[] = [];
  
  if (toolpath.length === 0) return gcode;

  // Calculate radius for each point
  // For 2-axis turning: x = radius, y = 0, so radius = x
  // For 4-axis rotated data: x = r*cos(a), y = r*sin(a), so radius = sqrt(x² + y²)
  const getRadius = (p: ToolpathPoint): number => {
    if (p.y === 0 || Math.abs(p.y) < 0.001) {
      // 2-axis mode: x is the radius directly
      return Math.abs(p.x);
    } else {
      // 4-axis mode: calculate radius from x,y
      return Math.sqrt(p.x * p.x + p.y * p.y);
    }
  };

  // Find profile bounds - radius values converted to diameter
  const radiusValues = toolpath.map(p => getRadius(p));
  const maxRadius = Math.max(...radiusValues);
  const maxDiameter = maxRadius * 2;

  // Group points by Z position to form profile segments
  // For each Z level, we want the ACTUAL profile radius (not min X which could be 0 in 4-axis)
  const zLevels = new Map<number, number>();
  for (const point of toolpath) {
    const z = Math.round(point.z * 10) / 10; // Round to 0.1mm
    const radius = getRadius(point);
    
    // For profile turning, we want the innermost radius at each Z
    // But we need a valid radius (not 0 from 4-axis rotation artifacts)
    if (!zLevels.has(z)) {
      zLevels.set(z, radius);
    } else {
      // Keep the smaller radius (innermost cut) but only if it's a real profile value
      const existing = zLevels.get(z)!;
      if (radius < existing && radius > 0.5) { // Must be > 0.5mm to be a real cut
        zLevels.set(z, radius);
      }
    }
  }

  // Sort Z levels - direction depends on reverse flag
  // Normal: Z0 toward negative (cutting direction away from headstock)
  // Reverse: from most negative Z back toward Z0 (sanding return pass)
  const sortedZLevels = Array.from(zLevels.entries())
    .sort((a, b) => reverse ? a[0] - b[0] : b[0] - a[0]);

  // Starting position depends on direction
  if (!reverse) {
    // Normal: start at Z0 with approach diameter
    const startDiameter = maxDiameter - 0.036 - diameterOffset;
    gcode.push(`G0X${startDiameter.toFixed(3)}Z0.000Z0`);
    gcode.push(`G1Z0 F${feedRate.toFixed(1)}`);
  }
  // For reverse, we're already at the end of the profile from the knife pass

  let lastRadius = reverse ? 0 : maxDiameter / 2;
  let lastZ = reverse ? -stockLength : 0;
  let isFirst = true;

  for (const [z, radius] of sortedZLevels) {
    // X in diameter mode (apply offset - subtract to go deeper into part)
    const xDiameter = radius * 2 - diameterOffset;
    const zNeg = z <= 0 ? z : -z;
    
    // Skip if beyond stock
    if (Math.abs(zNeg) > stockLength) continue;
    
    // For reverse sanding, first move sets the feed rate
    if (reverse && isFirst) {
      gcode.push(`G1X${xDiameter.toFixed(3)}Z${zNeg.toFixed(3)} F${feedRate.toFixed(1)}`);
      isFirst = false;
    } else if (Math.abs(xDiameter - (lastRadius * 2 - diameterOffset)) > 0.001 || Math.abs(zNeg - lastZ) > 0.001) {
      gcode.push(`X${xDiameter.toFixed(3)}Z${zNeg.toFixed(3)}`);
    }
    
    lastRadius = radius;
    lastZ = zNeg;
  }

  return gcode;
}

/**
 * Generate G-code for specific turning profiles (like Alice legs)
 * This creates the characteristic spindle profiles with multiple segments
 */
export function generateTurningProfile(
  segments: ProfileSegment[],
  options: {
    feedRate?: number;
    startDiameter?: number;
    stockLength?: number;
  } = {}
): string[] {
  const {
    feedRate = 200,
    startDiameter = 50,
    stockLength = 812.8
  } = options;

  const gcode: string[] = [];
  
  // Initial approach
  const approachDiam = startDiameter - 0.036;
  gcode.push(`G0X${approachDiam.toFixed(3)}Z0.000Z0`);
  gcode.push(`G1Z0 F${feedRate.toFixed(1)}`);

  for (const segment of segments) {
    // Each segment has start/end Z and a profile function
    const points = generateSegmentPoints(segment);
    for (const point of points) {
      gcode.push(`X${point.x.toFixed(3)}Z${point.z.toFixed(3)}`);
    }
  }

  return gcode;
}

interface ProfileSegment {
  startZ: number;
  endZ: number;
  startDiameter: number;
  endDiameter: number;
  profileType: 'linear' | 'convex' | 'concave' | 'bead';
}

interface ProfilePoint {
  x: number;  // diameter
  z: number;  // negative toward tailstock
}

function generateSegmentPoints(segment: ProfileSegment): ProfilePoint[] {
  const points: ProfilePoint[] = [];
  const steps = 100; // Resolution for curved segments
  
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const z = segment.startZ + (segment.endZ - segment.startZ) * t;
    
    let diameter: number;
    
    switch (segment.profileType) {
      case 'convex':
        // Outward bulge (like a bead or spindle leg)
        const bulge = Math.sin(t * Math.PI);
        const avgDiam = (segment.startDiameter + segment.endDiameter) / 2;
        const bulgeAmount = (segment.endDiameter - segment.startDiameter) / 2;
        diameter = segment.startDiameter + (segment.endDiameter - segment.startDiameter) * t + bulge * bulgeAmount;
        break;
        
      case 'concave':
        // Inward curve
        const indent = Math.sin(t * Math.PI);
        diameter = segment.startDiameter + (segment.endDiameter - segment.startDiameter) * t - indent * 5;
        break;
        
      case 'bead':
        // Full bead profile (out and back)
        const beadCurve = Math.sin(t * Math.PI);
        const maxBead = Math.max(segment.startDiameter, segment.endDiameter);
        diameter = Math.min(segment.startDiameter, segment.endDiameter) + beadCurve * (maxBead - Math.min(segment.startDiameter, segment.endDiameter));
        break;
        
      case 'linear':
      default:
        diameter = segment.startDiameter + (segment.endDiameter - segment.startDiameter) * t;
    }
    
    points.push({ x: diameter, z: z });
  }
  
  return points;
}

/**
 * Generate complete indexed milling job (wrapper for multiple operations)
 */
function generateIndexedMillingJob(
  data: ProjectData,
  options: {
    projectName?: string;
    stockLength?: number;
    safeX?: number;
    safeY?: number;
  } = {}
): string {
  const gcode: string[] = [];
  const {
    projectName = "Indexed Milling Job",
    stockLength = data.stock?.length || 200,
    safeX = 100,
    safeY = 75,
  } = options;
  
  const quantity = data.quantity || 1;
  const formatTool = (n: number) => `T0${n}0${n}`;

  // Project name header
  gcode.push(projectName);
  gcode.push('');
  
  // Tool list
  gcode.push('T0909');
  gcode.push('T0202');
  gcode.push('');
  gcode.push('T0707');
  gcode.push('');

  // Quantity loop
  for (let pieceNum = 1; pieceNum <= quantity; pieceNum++) {
    if (quantity > 1) {
      gcode.push(`(PIECE ${pieceNum} OF ${quantity})`);
      gcode.push('');
    }
    
    // Load and clamp
    gcode.push('M69');
    gcode.push('M70');
    gcode.push('M71');
    gcode.push('M72');
    gcode.push('');
    gcode.push('M68');
    gcode.push('');

    // Find indexed operations and generate G-code for each
    const indexedOps = data.operations?.filter(op => op.rotationMode === 'indexed') || [];
    
    for (const op of indexedOps) {
      const opGcode = generateIndexedMillingGCode(data, op, { safeX, safeY, safeZ: 50 });
      gcode.push(...opGcode);
    }

    // Check for sanding operations
    const sandingOps = data.operations?.filter(op => op.type === 'sanding') || [];
    for (const op of sandingOps) {
      gcode.push('');
      gcode.push(`(SANDING)`);
      gcode.push(formatTool(op.toolNumber));
      gcode.push('');
      gcode.push(`M03 S${op.params.spindleSpeed || 2400}`);
      gcode.push(`G0 X${safeX} Y${safeY} Z0`);
      gcode.push(`G1 Z-${stockLength.toFixed(1)} F${op.params.feedRate || 1500}`);
      gcode.push(`G0 Z50`);
    }

    // End of piece
    gcode.push('');
    gcode.push('M05');
    gcode.push('M77');
    gcode.push('');
    gcode.push('T0707'); // Drop piece
    gcode.push('');
    gcode.push('T0202');
    gcode.push('');
  }
  
  gcode.push('M30');
  
  return gcode.join('\n');
}

/**
 * Generate indexed milling G-code for multi-sided operations
 * (e.g., 4-sided tapered legs)
 * 
 * For indexed milling to create FLAT faces:
 * - Workpiece rotates to fixed A-axis positions (e.g., 0°, 90°, 180°, 270°)
 * - At each position, tool mills a flat plane from stock surface toward center
 * - Profile defines how deep to cut at each Z position (Y axis = depth from surface)
 * - X is fixed at the face position, Z traverses length, Y = cut depth
 * 
 * Coordinate mapping for flat face milling:
 * - X = fixed position at edge of stock (where flat face is)
 * - Y = depth of cut from stock surface toward center (stockRadius - profileRadius)
 * - Z = position along workpiece length
 */
export function generateIndexedMillingGCode(
  data: ProjectData,
  operation: Operation,
  options: {
    safeX?: number;
    safeY?: number;
    safeZ?: number;
  } = {}
): string[] {
  const gcode: string[] = [];
  const {
    safeX = 100,
    safeY = 75,
    safeZ = 50,
  } = options;

  const stockLength = data.stock?.length || 200;
  const stockDiameter = data.stock?.diameter || 100;
  const stockRadius = stockDiameter / 2;
  
  // Get operation parameters
  const feedRate = operation.params.feedRate || 200;
  const spindleRPM = operation.params.spindleSpeed || 2100;
  const depthOfCut = operation.params.depthOfCut || 2;
  const indexCount = operation.params.indexCount || 4;
  const indexAngle = operation.params.indexAngle || (360 / indexCount);
  
  // Format tool number
  const formatTool = (n: number) => `T0${n}0${n}`;

  gcode.push(`(INDEXED MILLING - ${indexCount} FLAT SIDES)`);
  gcode.push(`(STOCK: ${stockDiameter}mm DIA x ${stockLength}mm LENGTH)`);
  gcode.push('');
  
  // Tool change
  gcode.push(formatTool(operation.toolNumber));
  gcode.push('');
  
  // Initial setup
  gcode.push(`G0 X${safeX} Y${safeY} Z${safeZ}`);
  gcode.push(`M03 S${spindleRPM}`);
  gcode.push('M76'); // Auxiliary on
  gcode.push('');
  
  if (!data.toolpath || data.toolpath.length === 0) {
    gcode.push('(NO TOOLPATH DATA)');
    return gcode;
  }
  
  // Get radius helper (handles both 2D and 4D toolpath formats)
  const getRadius = (p: ToolpathPoint): number => {
    if (p.y === 0 || Math.abs(p.y) < 0.001) {
      return Math.abs(p.x);
    }
    return Math.sqrt(p.x * p.x + p.y * p.y);
  };
  
  // Build profile: group by Z, get target radius at each Z level
  const zLevels = new Map<number, number>();
  for (const point of data.toolpath) {
    const z = Math.round(point.z * 10) / 10;
    const radius = getRadius(point);
    if (!zLevels.has(z) || radius < zLevels.get(z)!) {
      zLevels.set(z, radius);
    }
  }
  
  // Sort by Z (from Z0 toward tailstock = more negative)
  const sortedProfile = Array.from(zLevels.entries())
    .sort((a, b) => b[0] - a[0]); // Z0 first, then -Z
  
  // Get profile radius range
  const profileRadii = Array.from(zLevels.values());
  const maxProfileRadius = Math.max(...profileRadii);
  const minProfileRadius = Math.min(...profileRadii);
  
  // Maximum depth to remove = from stock surface to minimum profile radius
  const maxRemovalDepth = stockRadius - minProfileRadius;
  
  if (maxRemovalDepth <= 0) {
    gcode.push('(PROFILE LARGER THAN STOCK - NO CUTTING NEEDED)');
    return gcode;
  }
  
  gcode.push(`(TAPER: ${(maxProfileRadius * 2).toFixed(1)}mm -> ${(minProfileRadius * 2).toFixed(1)}mm)`);
  gcode.push(`(MAX REMOVAL DEPTH: ${maxRemovalDepth.toFixed(2)}mm)`);
  gcode.push('');
  
  // For each indexed position (each flat face)
  for (let i = 0; i < indexCount; i++) {
    const currentAngle = i * indexAngle;
    
    gcode.push(`(SIDE ${i + 1} OF ${indexCount} - A${currentAngle.toFixed(1)} DEGREES)`);
    
    // Rotate A-axis to indexed position
    gcode.push(`G0 A${currentAngle.toFixed(1)}`);
    gcode.push('');
    
    // Multi-pass roughing from stock surface down to profile
    // For flat face milling: Y represents depth from stock surface toward center
    const numPasses = Math.max(1, Math.ceil(maxRemovalDepth / depthOfCut));
    
    for (let pass = 1; pass <= numPasses; pass++) {
      const passRemovalMax = Math.min(pass * depthOfCut, maxRemovalDepth);
      
      gcode.push(`(PASS ${pass}/${numPasses})`);
      
      // SAFE APPROACH SEQUENCE:
      // 1. Retract to safe Z first (away from workpiece)
      gcode.push(`G0 Z${safeZ}`);
      // 2. Move to safe X and Y at safe Z
      gcode.push(`G0 X${stockRadius.toFixed(3)} Y${safeY}`);
      // 3. Rapid to Z=0 at safe Y (above workpiece surface)
      gcode.push(`G0 Z0`);
      
      // Get first profile point - always start at Z=0
      const firstProfileRadius = sortedProfile.find(([z]) => z === 0)?.[1] || sortedProfile[0][1];
      const firstDepth = Math.min(stockRadius - firstProfileRadius, passRemovalMax);
      const startY = -firstDepth; // Negative Y = toward the face (depth into material)
      
      // 4. Feed plunge to cutting depth at Z=0
      gcode.push(`G1 Y${startY.toFixed(3)} F${feedRate}`);
      
      // Cut along the profile following the taper from Z=0 toward tailstock
      for (const [z, profileRadius] of sortedProfile) {
        // Skip points beyond stock length
        if (Math.abs(z) > stockLength) continue;
        // Skip positive Z (before headstock face)
        if (z > 0) continue;
        
        // Calculate Y depth for this Z position
        // Full depth = stockRadius - profileRadius
        // But limit to current pass's maximum removal
        const targetDepth = stockRadius - profileRadius;
        const actualDepth = Math.min(targetDepth, passRemovalMax);
        const yPos = -actualDepth; // Negative Y = toward the flat face
        
        gcode.push(`G1 Y${yPos.toFixed(3)} Z${z.toFixed(3)}`);
      }
      
      // SAFE RETRACT SEQUENCE:
      // 1. Retract Y first (away from workpiece)
      gcode.push(`G0 Y${safeY}`);
      // 2. Then retract Z
      gcode.push(`G0 Z${safeZ}`);
      gcode.push('');
    }
  }
  
  // Return to home position
  gcode.push('G0 A0');
  gcode.push(`G0 X${safeX} Y${safeY} Z${safeZ}`);
  
  return gcode;
}

/**
 * Generate sanding pass G-code
 */
export function generateSandingGCode(
  data: ProjectData,
  options: {
    toolNumber?: number;
    sandingRPM?: number;
    sandingFeed?: number;
    passes?: number;
    contactPressure?: number;
  } = {}
): string[] {
  const gcode: string[] = [];
  const {
    toolNumber = 3,
    sandingRPM = 2400,
    sandingFeed = 1500,
    passes = 2,
    contactPressure = 0.5
  } = options;

  const stockDiameter = data.stock?.diameter || 100;
  const stockLength = data.stock?.length || 910;
  const safeX = stockDiameter + 10;
  const contactX = stockDiameter - contactPressure * 2;

  gcode.push('');
  gcode.push(`T${toolNumber.toString().padStart(2, '0')}${toolNumber.toString().padStart(2, '0')}`);
  
  gcode.push(`G0 X${safeX.toFixed(1)}`);
  gcode.push('G0 Z10');
  gcode.push(`M03 S${sandingRPM}`);
  gcode.push('M76');
  gcode.push('');

  for (let pass = 1; pass <= passes; pass++) {
    gcode.push('G0 Z0');
    gcode.push(`G1 X${contactX.toFixed(3)} F${sandingFeed}`);
    gcode.push(`G1 Z-${stockLength.toFixed(1)} F${sandingFeed}`);
    gcode.push(`G0 X${safeX.toFixed(1)}`);
    gcode.push('G0 Z0');
    gcode.push('');
  }

  gcode.push(`G0 X${safeX.toFixed(1)}`);
  gcode.push('G0 Z10');

  return gcode;
}

/**
 * Parse G-code string back into toolpath points
 * Used for importing existing G-code files
 */
export function parseGCode(gcode: string): ToolpathPoint[] {
  const lines = gcode.split('\n');
  const toolpath: ToolpathPoint[] = [];
  
  let currentX = 0;
  let currentY = 0;
  let currentZ = 0;
  let currentA = 0;
  let currentFeed = 200;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('(') || trimmed.startsWith('%')) continue;

    // Extract coordinates - X in Catek is diameter, convert to radius for internal use
    const xMatch = trimmed.match(/X(-?\d+\.?\d*)/i);
    const yMatch = trimmed.match(/Y(-?\d+\.?\d*)/i);
    const zMatch = trimmed.match(/Z(-?\d+\.?\d*)/i);
    const aMatch = trimmed.match(/A(-?\d+\.?\d*)/i);
    const fMatch = trimmed.match(/F(\d+\.?\d*)/i);

    if (xMatch) currentX = parseFloat(xMatch[1]) / 2; // Convert diameter to radius
    if (yMatch) currentY = parseFloat(yMatch[1]);
    if (zMatch) currentZ = parseFloat(zMatch[1]);
    if (aMatch) currentA = parseFloat(aMatch[1]);
    if (fMatch) currentFeed = parseFloat(fMatch[1]);

    // Add point if it's a motion command with any coordinates (including A-axis)
    const isMotionCommand = trimmed.startsWith('G0') || trimmed.startsWith('G1') || trimmed.match(/^[XYZA]/i);
    const hasCoordinates = xMatch || yMatch || zMatch || aMatch;
    
    if (isMotionCommand && hasCoordinates) {
      toolpath.push({
        x: currentX,
        y: currentY,
        z: currentZ,
        a: currentA,
        feedRate: currentFeed
      });
    }
  }

  return toolpath;
}
