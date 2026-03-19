import {
  ProjectData, ToolpathPoint, Operation, MachineConfig, SpindleConfig,
  ProfileSegment3D, Point3D,
  DrillingParams, GroovingParams, ThreadingParams, PlaningParams,
  EngravingParams, Carving3DParams, Contouring4AxisParams
} from "@shared/schema";

/**
 * Catek CNC 7-in-1 Wood Lathe G-Code Generator
 *
 * Supports all 7 operations:
 * 1. Turning (continuous A-axis)
 * 2. Milling (indexed or simultaneous 4-axis)
 * 3. Drilling (G81/G83 canned cycles)
 * 4. Grooving (plunge cycles)
 * 5. Planing (surface flattening with planer spindle)
 * 6. Engraving (2D vector/text toolpath)
 * 7. 3D Carving (simultaneous 4-axis surface machining)
 * + Sanding, Threading, Contouring
 *
 * Format:
 * - X axis: Diameter mode (not radius)
 * - Z axis: Z0 at spindle face, negative toward tailstock
 * - Tool format: Ttttt (e.g., T0909)
 * - Arc: G02 (CW) / G03 (CCW) with I/J/K
 * - Tool comp: G41 (left) / G42 (right) / G40 (cancel)
 */

// ============================================================
// TYPES
// ============================================================

export interface GCodeGeneratorOptions {
  projectName?: string;
  machineConfig?: MachineConfig;
  includeComments?: boolean;
  stockLength?: number;
  cuttingFeed?: number;
  spindleRPM?: number;
  safeX?: number;
  safeY?: number;
  roughingDiameter?: number;
  singleRoughingPass?: boolean;
  knifeToolNumber?: number;
  sandingToolNumber?: number;
  paddleOffset?: number;
  sandingRPM?: number;
  sandingFeed?: number;
}

// ============================================================
// HELPERS
// ============================================================

/** Format tool number as Ttttt (e.g., 4 -> T0404) */
function formatTool(n: number): string {
  const s = n.toString().padStart(2, '0');
  return `T${s}${s}`;
}

/** Get spindle M-codes from config, falling back to defaults */
function getSpindleCodes(
  spindleId: string | undefined,
  config?: MachineConfig
): { start: string; stop: string; reverse?: string } {
  if (config && spindleId) {
    const spindle = config.spindles.find(s => s.id === spindleId);
    if (spindle) return spindle.mCodes;
  }
  return { start: 'M03', stop: 'M05', reverse: 'M04' };
}

/** Calculate radius from toolpath point (handles 2D and 4D formats) */
function getRadius(p: ToolpathPoint): number {
  if (p.y === 0 || Math.abs(p.y) < 0.001) {
    return Math.abs(p.x);
  }
  return Math.sqrt(p.x * p.x + p.y * p.y);
}

/** Format a number to fixed decimal, trimming trailing zeros */
function fmt(n: number, decimals: number = 3): string {
  return n.toFixed(decimals);
}

// ============================================================
// MAIN GENERATOR
// ============================================================

export function generateGCode(
  data: ProjectData,
  options: GCodeGeneratorOptions = {}
): string {
  const {
    projectName = "Untitled",
    machineConfig,
    stockLength = data.stock?.length || 910,
    cuttingFeed = 200,
    spindleRPM = 2100,
    safeX = machineConfig?.safeX ?? 100,
    safeY = machineConfig?.safeY ?? 75,
    roughingDiameter = data.stock?.diameter || 110,
    singleRoughingPass = true,
    knifeToolNumber = 4,
    sandingToolNumber = 3,
    paddleOffset = 1.0,
    sandingRPM = 2400,
    sandingFeed = 1500,
  } = options;

  if (!data || !data.toolpath || data.toolpath.length === 0) {
    return "No toolpath data";
  }

  const gcode: string[] = [];
  const stockDiameter = data.stock?.diameter || 100;
  const quantity = data.quantity || 1;

  // Classify operations
  const hasContinuousOps = data.operations?.some(op =>
    op.rotationMode === 'continuous' ||
    op.type === 'turning' ||
    op.type === 'sanding'
  );
  const hasIndexedOps = data.operations?.some(op => op.rotationMode === 'indexed');
  const hasAdvancedOps = data.operations?.some(op =>
    ['drilling', 'grooving', 'threading', 'planing', 'engraving', 'carving_3d', 'contouring_4axis'].includes(op.type)
  );

  // If only indexed operations (no turning/sanding), use indexed milling workflow
  if (hasIndexedOps && !hasContinuousOps && !hasAdvancedOps) {
    return generateIndexedMillingJob(data, { projectName, stockLength, safeX, safeY, machineConfig });
  }

  // Project name header
  gcode.push(projectName);
  gcode.push('');

  // === INITIALIZATION ===
  gcode.push('T0909');
  gcode.push('T0202');
  gcode.push('');
  gcode.push('T0707');
  gcode.push('');

  // === QUANTITY LOOP ===
  for (let pieceNum = 1; pieceNum <= quantity; pieceNum++) {
    if (quantity > 1) {
      gcode.push(`(PIECE ${pieceNum} OF ${quantity})`);
      gcode.push('');
    }

    // === LOAD AND CLAMP ===
    const loader = machineConfig?.loaderCodes;
    gcode.push(loader?.release ?? 'M69');
    gcode.push(loader?.start ?? 'M70');
    gcode.push(loader?.position ?? 'M71');
    gcode.push(loader?.complete ?? 'M72');
    gcode.push('');
    gcode.push(loader?.clamp ?? 'M68');
    gcode.push('');

    // Process each operation in order
    if (data.operations && data.operations.length > 0) {
      for (const op of data.operations) {
        const opGcode = generateOperationGCode(data, op, {
          safeX, safeY, safeZ: machineConfig?.safeZ ?? 50,
          stockLength, stockDiameter, machineConfig,
          cuttingFeed, spindleRPM, singleRoughingPass,
          knifeToolNumber, sandingToolNumber,
          paddleOffset, sandingRPM, sandingFeed,
        });
        gcode.push(...opGcode);
      }
    } else {
      // Fallback: legacy turning + sanding workflow
      const legacyGcode = generateLegacyTurningWorkflow(data, {
        safeX, safeY, stockLength, stockDiameter, cuttingFeed, spindleRPM,
        singleRoughingPass, knifeToolNumber, sandingToolNumber,
        paddleOffset, sandingRPM, sandingFeed,
      });
      gcode.push(...legacyGcode);
    }

    // === END OF PIECE ===
    gcode.push('');
    gcode.push('M05');
    gcode.push(machineConfig?.auxCodes?.dustOff ?? 'M77');
    gcode.push('');
    gcode.push('T0707'); // Drop piece
    gcode.push('');
    gcode.push('T0202');
    gcode.push('');
  }

  gcode.push(machineConfig?.postProcessor?.programEnd ?? 'M30');
  return gcode.join('\n');
}

// ============================================================
// OPERATION DISPATCHER
// ============================================================

interface OpContext {
  safeX: number;
  safeY: number;
  safeZ: number;
  stockLength: number;
  stockDiameter: number;
  machineConfig?: MachineConfig;
  cuttingFeed: number;
  spindleRPM: number;
  singleRoughingPass: boolean;
  knifeToolNumber: number;
  sandingToolNumber: number;
  paddleOffset: number;
  sandingRPM: number;
  sandingFeed: number;
}

function generateOperationGCode(data: ProjectData, op: Operation, ctx: OpContext): string[] {
  const gcode: string[] = [];
  gcode.push('');
  gcode.push(`(${op.type.toUpperCase()} - TOOL ${op.toolNumber})`);

  switch (op.type) {
    case 'roughing':
      return [...gcode, ...generateRoughingGCode(data, op, ctx)];
    case 'turning':
    case 'finishing':
      return [...gcode, ...generateTurningGCode(data, op, ctx)];
    case 'sanding':
      return [...gcode, ...generateSandingOpGCode(data, op, ctx)];
    case 'milling':
    case 'routing':
      if (op.rotationMode === 'indexed') {
        return [...gcode, ...generateIndexedMillingGCode(data, op, { safeX: ctx.safeX, safeY: ctx.safeY, safeZ: ctx.safeZ })];
      }
      return [...gcode, ...generateMillingGCode(data, op, ctx)];
    case 'drilling':
      return [...gcode, ...generateDrillingGCode(data, op, ctx)];
    case 'grooving':
      return [...gcode, ...generateGroovingGCode(data, op, ctx)];
    case 'threading':
      return [...gcode, ...generateThreadingGCode(data, op, ctx)];
    case 'planing':
      return [...gcode, ...generatePlaningGCode(data, op, ctx)];
    case 'engraving':
      return [...gcode, ...generateEngravingGCode(data, op, ctx)];
    case 'carving_3d':
      return [...gcode, ...generateCarving3DGCode(data, op, ctx)];
    case 'contouring_4axis':
      return [...gcode, ...generateContouring4AxisGCode(data, op, ctx)];
    default:
      gcode.push(`(UNSUPPORTED OPERATION: ${op.type})`);
      return gcode;
  }
}

// ============================================================
// ROUGHING
// ============================================================

function generateRoughingGCode(data: ProjectData, op: Operation, ctx: OpContext): string[] {
  const gcode: string[] = [];
  const spindleCodes = getSpindleCodes(op.spindleId, ctx.machineConfig);
  const rpm = op.params.spindleSpeed || ctx.spindleRPM;
  const feed = op.params.feedRate || ctx.cuttingFeed;
  const depthPerPass = op.params.depthOfCut || 3;

  const minProfileRadius = Math.min(...data.toolpath.map(p => getRadius(p)));
  const roughTargetDiameter = minProfileRadius * 2 + (op.params.allowance ?? 2);

  gcode.push(formatTool(op.toolNumber));
  gcode.push('');
  gcode.push('G0Z0');
  gcode.push(`G0X${ctx.safeX} Z0 Y${ctx.safeY}`);
  gcode.push(`${spindleCodes.start} S${rpm}`);
  gcode.push(ctx.machineConfig?.auxCodes?.dustOn ?? 'M76');
  gcode.push('');

  // Tool compensation
  if (op.compensationMode === 'left') gcode.push(`G41 D${op.toolNumber.toString().padStart(2,'0')}`);
  else if (op.compensationMode === 'right') gcode.push(`G42 D${op.toolNumber.toString().padStart(2,'0')}`);

  if (ctx.singleRoughingPass || depthPerPass * 2 >= (ctx.stockDiameter - roughTargetDiameter)) {
    gcode.push(`G0X${fmt(roughTargetDiameter)} Z0`);
    gcode.push(`G1Z-${fmt(ctx.stockLength, 1)} F${fmt(feed, 0)}`);
    gcode.push(`G0X${ctx.safeX}`);
  } else {
    let currentDiameter = ctx.stockDiameter;
    while (currentDiameter > roughTargetDiameter) {
      currentDiameter = Math.max(currentDiameter - depthPerPass * 2, roughTargetDiameter);
      gcode.push(`G0X${ctx.safeX} Z0`);
      gcode.push(`G0X${fmt(currentDiameter)} Z0`);
      gcode.push(`G1Z-${fmt(ctx.stockLength, 1)} F${fmt(feed, 0)}`);
      gcode.push(`G0X${ctx.safeX}`);
    }
  }

  if (op.compensationMode && op.compensationMode !== 'none') gcode.push('G40');
  gcode.push(`G0 X${ctx.safeX} Z0`);
  return gcode;
}

// ============================================================
// TURNING / FINISHING
// ============================================================

function generateTurningGCode(data: ProjectData, op: Operation, ctx: OpContext): string[] {
  const gcode: string[] = [];
  const spindleCodes = getSpindleCodes(op.spindleId, ctx.machineConfig);
  const feed = op.params.feedRate || ctx.cuttingFeed;

  gcode.push(formatTool(op.toolNumber));
  gcode.push('');
  gcode.push(`G0 X${ctx.safeX} Z0`);
  gcode.push(`${spindleCodes.start} S${op.params.spindleSpeed || ctx.spindleRPM}`);
  gcode.push('');

  if (op.compensationMode === 'left') gcode.push(`G41 D${op.toolNumber.toString().padStart(2,'0')}`);
  else if (op.compensationMode === 'right') gcode.push(`G42 D${op.toolNumber.toString().padStart(2,'0')}`);

  const profileGcode = generateProfileFromToolpath(data.toolpath, feed, ctx.stockLength, ctx.stockDiameter, 0);
  gcode.push(...profileGcode);

  if (op.compensationMode && op.compensationMode !== 'none') gcode.push('G40');
  return gcode;
}

// ============================================================
// SANDING
// ============================================================

function generateSandingOpGCode(data: ProjectData, op: Operation, ctx: OpContext): string[] {
  const gcode: string[] = [];
  const spindleCodes = getSpindleCodes(op.spindleId ?? 'sanding', ctx.machineConfig);
  const actualPaddleOffset = op.params.paddleOffset ?? ctx.paddleOffset;
  const actualFeed = op.params.feedRate ?? ctx.sandingFeed;
  const actualRPM = op.params.spindleSpeed ?? ctx.sandingRPM;

  gcode.push(formatTool(op.toolNumber));
  gcode.push('');
  gcode.push(`${spindleCodes.start} S${actualRPM}`);

  const sandingGcode = generateProfileFromToolpath(
    data.toolpath,
    actualFeed,
    ctx.stockLength,
    ctx.stockDiameter,
    actualPaddleOffset * 2,
    true
  );
  gcode.push(...sandingGcode);
  gcode.push(`G0X${ctx.safeX} Z0`);
  return gcode;
}

// ============================================================
// DRILLING (G81/G83 Canned Cycles)
// ============================================================

function generateDrillingGCode(data: ProjectData, op: Operation, ctx: OpContext): string[] {
  const gcode: string[] = [];
  const spindleCodes = getSpindleCodes(op.spindleId, ctx.machineConfig);
  const params = op.params.drilling;
  const feed = op.params.feedRate || 100;
  const rpm = op.params.spindleSpeed || 1500;

  if (!params) {
    gcode.push('(NO DRILLING PARAMETERS DEFINED)');
    return gcode;
  }

  gcode.push(formatTool(op.toolNumber));
  gcode.push('');
  gcode.push(`${spindleCodes.start} S${rpm}`);
  gcode.push(ctx.machineConfig?.auxCodes?.dustOn ?? 'M76');
  gcode.push('');

  const retract = params.retractHeight || 2;
  const holeDepth = params.holeDepth;
  const peckDepth = params.peckDepth || holeDepth;
  const stockRadius = ctx.stockDiameter / 2;

  // Get hole positions
  const positions = params.holePattern?.positions || [{ x: 0, y: 0, z: -ctx.stockLength / 2 }];
  const indexAngles = params.holePattern?.indexAngles;

  // Generate holes at indexed A-axis positions
  const angles = indexAngles || [0];
  for (const angle of angles) {
    if (angles.length > 1) {
      gcode.push(`(A-AXIS ${angle}°)`);
      gcode.push(`G0 A${fmt(angle, 1)}`);
    }

    for (const pos of positions) {
      // Position above the hole
      gcode.push(`G0 X${fmt(stockRadius * 2)} Z${fmt(pos.z)}`);

      // Drill at the stock surface (X = stock diameter for radial drilling)
      const rPlane = stockRadius * 2 + retract;
      const zBottom = -holeDepth; // depth into workpiece from surface

      if (params.drillCycle === 'spot') {
        // G81 spot drill
        gcode.push(`G81 X${fmt(stockRadius * 2 - holeDepth)} Z${fmt(pos.z)} R${fmt(rPlane)} F${fmt(feed, 0)}`);
      } else if (params.drillCycle === 'deep_peck') {
        // G83 deep hole peck drill
        gcode.push(`G83 X${fmt(stockRadius * 2 - holeDepth)} Z${fmt(pos.z)} R${fmt(rPlane)} Q${fmt(peckDepth)} F${fmt(feed, 0)}`);
      } else {
        // G83 standard peck drill
        gcode.push(`G83 X${fmt(stockRadius * 2 - holeDepth)} Z${fmt(pos.z)} R${fmt(rPlane)} Q${fmt(peckDepth)} F${fmt(feed, 0)}`);
      }
    }
  }

  gcode.push('G80'); // Cancel canned cycle
  gcode.push(`G0 X${ctx.safeX} Z${ctx.safeZ}`);
  if (angles.length > 1) gcode.push('G0 A0');
  return gcode;
}

// ============================================================
// GROOVING (Plunge Cycles)
// ============================================================

function generateGroovingGCode(data: ProjectData, op: Operation, ctx: OpContext): string[] {
  const gcode: string[] = [];
  const spindleCodes = getSpindleCodes(op.spindleId, ctx.machineConfig);
  const params = op.params.grooving;
  const feed = op.params.feedRate || 50;
  const rpm = op.params.spindleSpeed || ctx.spindleRPM;

  if (!params) {
    gcode.push('(NO GROOVING PARAMETERS DEFINED)');
    return gcode;
  }

  gcode.push(formatTool(op.toolNumber));
  gcode.push('');
  gcode.push(`${spindleCodes.start} S${rpm}`);
  gcode.push('');

  const stockRadius = ctx.stockDiameter / 2;
  const targetDiameter = ctx.stockDiameter - params.grooveDepth * 2;

  for (let i = 0; i < params.zPositions.length; i++) {
    const z = params.zPositions[i];
    gcode.push(`(GROOVE ${i + 1} AT Z${fmt(z)})`);

    // Position above groove
    gcode.push(`G0 X${fmt(ctx.stockDiameter + 2)} Z${fmt(z)}`);

    if (params.grooveProfile === 'v' && params.vAngle) {
      // V-groove: plunge at angle
      const halfAngleRad = (params.vAngle / 2) * Math.PI / 180;
      const halfWidth = params.grooveDepth * Math.tan(halfAngleRad);
      const startZ = z + halfWidth;
      const endZ = z - halfWidth;

      gcode.push(`G0 X${fmt(ctx.stockDiameter + 1)} Z${fmt(startZ)}`);
      gcode.push(`G1 X${fmt(targetDiameter)} Z${fmt(z)} F${fmt(feed, 0)}`);
      gcode.push(`G1 X${fmt(ctx.stockDiameter + 1)} Z${fmt(endZ)}`);
    } else if (params.grooveProfile === 'round') {
      // Round groove: arc plunge
      const arcRadius = params.grooveDepth;
      gcode.push(`G0 X${fmt(ctx.stockDiameter + 1)} Z${fmt(z - arcRadius)}`);
      gcode.push(`G1 X${fmt(ctx.stockDiameter)} Z${fmt(z - arcRadius)} F${fmt(feed, 0)}`);
      // Arc from left to bottom to right
      gcode.push(`G03 X${fmt(targetDiameter)} Z${fmt(z)} I0 K${fmt(arcRadius)}`);
      gcode.push(`G03 X${fmt(ctx.stockDiameter)} Z${fmt(z + arcRadius)} I${fmt(params.grooveDepth)} K0`);
    } else {
      // Square groove: straight plunge, optional multi-pass for wide grooves
      const toolWidth = 3; // Assume 3mm default tool width
      const passCount = Math.max(1, Math.ceil(params.grooveWidth / toolWidth));
      const stepover = params.grooveWidth / passCount;

      for (let p = 0; p < passCount; p++) {
        const passZ = z - params.grooveWidth / 2 + stepover * p + stepover / 2;
        gcode.push(`G0 X${fmt(ctx.stockDiameter + 1)} Z${fmt(passZ)}`);
        gcode.push(`G1 X${fmt(targetDiameter)} F${fmt(feed, 0)}`);
        gcode.push(`G0 X${fmt(ctx.stockDiameter + 1)}`);
      }
    }
    gcode.push('');
  }

  gcode.push(`G0 X${ctx.safeX} Z${ctx.safeZ}`);
  return gcode;
}

// ============================================================
// THREADING (G76 Compound Cycle)
// ============================================================

function generateThreadingGCode(data: ProjectData, op: Operation, ctx: OpContext): string[] {
  const gcode: string[] = [];
  const spindleCodes = getSpindleCodes(op.spindleId, ctx.machineConfig);
  const params = op.params.threading;
  const rpm = op.params.spindleSpeed || 300; // Threading is slow

  if (!params) {
    gcode.push('(NO THREADING PARAMETERS DEFINED)');
    return gcode;
  }

  gcode.push(formatTool(op.toolNumber));
  gcode.push('');
  gcode.push(`${spindleCodes.start} S${rpm}`);
  gcode.push('');

  const isExternal = params.threadType === 'external';
  const stockDia = ctx.stockDiameter;

  // G76 compound threading cycle (Fanuc format)
  // G76 P{m}{r}{a} Q{dmin} R{d}
  // G76 X{final_dia} Z{end_z} P{depth} Q{first_cut} F{pitch}
  //
  // m = number of spring passes (00-99)
  // r = chamfer amount (00-99, in 0.1 pitch units)
  // a = infeed angle (0, 29, 30, 55, 60)
  // dmin = minimum cut depth (microns)
  // d = finishing allowance (microns)

  const springStr = params.springPasses.toString().padStart(2, '0');
  const chamferStr = '10'; // 1.0 pitch chamfer
  const angleStr = Math.round(params.infeedAngle).toString().padStart(2, '0');
  const minCutMicrons = Math.round(params.minCutDepth * 1000);
  const finishAllowance = Math.round(0.05 * 1000); // 0.05mm finish allowance

  // Thread depth in microns for P word
  const depthMicrons = Math.round(params.threadDepth * 1000);
  // First cut depth in microns for Q word
  const firstCutMicrons = Math.round(params.firstCutDepth * 1000);

  let finalDiameter: number;
  if (isExternal) {
    finalDiameter = stockDia - params.threadDepth * 2;
  } else {
    finalDiameter = stockDia + params.threadDepth * 2;
  }

  gcode.push(`(${params.threadForm.toUpperCase()} THREAD - ${params.pitch}mm PITCH)`);
  gcode.push(`(${isExternal ? 'EXTERNAL' : 'INTERNAL'} - DEPTH ${params.threadDepth}mm)`);
  gcode.push('');

  // Position at start
  gcode.push(`G0 X${fmt(stockDia + 5)} Z${fmt(params.startZ + 5)}`);

  // First G76 line: spring passes, chamfer, angle, min depth, finish allowance
  gcode.push(`G76 P${springStr}${chamferStr}${angleStr} Q${minCutMicrons} R${finishAllowance}`);
  // Second G76 line: final diameter, end Z, depth, first cut depth, pitch
  gcode.push(`G76 X${fmt(finalDiameter)} Z${fmt(params.endZ)} P${depthMicrons} Q${firstCutMicrons} F${fmt(params.pitch)}`);
  gcode.push('');

  gcode.push(`G0 X${ctx.safeX} Z${ctx.safeZ}`);
  return gcode;
}

// ============================================================
// PLANING (Surface Flattening)
// ============================================================

function generatePlaningGCode(data: ProjectData, op: Operation, ctx: OpContext): string[] {
  const gcode: string[] = [];
  const spindleCodes = getSpindleCodes(op.spindleId ?? 'planer', ctx.machineConfig);
  const params = op.params.planing;
  const feed = op.params.feedRate || 500;
  const rpm = op.params.spindleSpeed || 12000;

  if (!params) {
    gcode.push('(NO PLANING PARAMETERS DEFINED)');
    return gcode;
  }

  gcode.push(formatTool(op.toolNumber));
  gcode.push('');

  const stockRadius = ctx.stockDiameter / 2;
  const aAngle = params.aAxisAngle ?? 0;
  const totalDepth = params.flatteningAllowance;
  const depthPerPass = params.planerDepthPerPass || 2;
  const numPasses = Math.max(1, Math.ceil(totalDepth / depthPerPass));

  // Lock A-axis at target face angle
  gcode.push(`G0 A${fmt(aAngle, 1)}`);
  gcode.push(`G0 X${ctx.safeX} Y${ctx.safeY} Z${ctx.safeZ}`);
  gcode.push(`${spindleCodes.start} S${rpm}`);
  gcode.push(ctx.machineConfig?.auxCodes?.dustOn ?? 'M76');
  gcode.push('');

  gcode.push(`(PLANING ${params.surfaceTarget.toUpperCase()} FACE - ${numPasses} PASSES)`);
  gcode.push(`(TOTAL REMOVAL: ${fmt(totalDepth, 1)}mm)`);
  gcode.push('');

  for (let pass = 1; pass <= numPasses; pass++) {
    const currentDepth = Math.min(pass * depthPerPass, totalDepth);
    const yPos = -(stockRadius - (stockRadius - currentDepth)); // Depth from surface

    gcode.push(`(PASS ${pass}/${numPasses} - DEPTH ${fmt(currentDepth, 1)}mm)`);
    gcode.push(`G0 Z5`);
    gcode.push(`G0 X${fmt(stockRadius)} Y${fmt(-currentDepth)}`);

    if (params.passDirection === 'climb') {
      gcode.push(`G1 Z-${fmt(ctx.stockLength)} F${fmt(feed, 0)}`);
    } else {
      gcode.push(`G0 Z-${fmt(ctx.stockLength)}`);
      gcode.push(`G1 Z5 F${fmt(feed, 0)}`);
    }

    gcode.push(`G0 Y${ctx.safeY}`);
    gcode.push('');
  }

  gcode.push(`${spindleCodes.stop}`);
  gcode.push(`G0 A0`);
  gcode.push(`G0 X${ctx.safeX} Y${ctx.safeY} Z${ctx.safeZ}`);
  return gcode;
}

// ============================================================
// ENGRAVING (2D Vector/Text)
// ============================================================

function generateEngravingGCode(data: ProjectData, op: Operation, ctx: OpContext): string[] {
  const gcode: string[] = [];
  const spindleCodes = getSpindleCodes(op.spindleId, ctx.machineConfig);
  const params = op.params.engraving;
  const feed = op.params.feedRate || 300;
  const rpm = op.params.spindleSpeed || 15000;

  if (!params) {
    gcode.push('(NO ENGRAVING PARAMETERS DEFINED)');
    return gcode;
  }

  gcode.push(formatTool(op.toolNumber));
  gcode.push('');

  // Lock A-axis at engraving surface angle
  gcode.push(`G0 A${fmt(params.surfaceAngle, 1)}`);
  gcode.push(`G0 X${ctx.safeX} Y${ctx.safeY} Z${ctx.safeZ}`);
  gcode.push(`${spindleCodes.start} S${rpm}`);
  gcode.push('');

  const stockRadius = ctx.stockDiameter / 2;
  const engravingDepth = params.engravingDepth || 1;

  if (params.text) {
    gcode.push(`(ENGRAVING TEXT: "${params.text}")`);
  }

  // Use toolpath data for engraving path if available
  // The engraving engine (server-side) converts text/SVG to toolpath points
  if (data.toolpath && data.toolpath.length > 0) {
    let penDown = false;

    for (const point of data.toolpath) {
      const z = point.z;
      const y = -(stockRadius - stockRadius + engravingDepth); // Surface depth

      if (point.moveType === 'rapid' || !penDown) {
        // Lift, move, plunge
        gcode.push(`G0 Y${ctx.safeY}`);
        gcode.push(`G0 Z${fmt(z)}`);
        gcode.push(`G1 Y${fmt(y)} F${fmt(feed * 0.5, 0)}`); // Slow plunge
        penDown = true;
      } else if (point.moveType === 'arc_cw' || point.moveType === 'arc_ccw') {
        // Arc move (from arc interpolation)
        const gCmd = point.moveType === 'arc_cw' ? 'G02' : 'G03';
        gcode.push(`${gCmd} Z${fmt(z)} Y${fmt(y)} F${fmt(feed, 0)}`);
      } else {
        // Linear engraving move
        gcode.push(`G1 Z${fmt(z)} Y${fmt(y)} F${fmt(feed, 0)}`);
      }
    }
    gcode.push(`G0 Y${ctx.safeY}`);
  } else {
    gcode.push('(NO TOOLPATH DATA FOR ENGRAVING - use engraving engine to generate paths)');
  }

  gcode.push(`${spindleCodes.stop}`);
  gcode.push(`G0 A0`);
  gcode.push(`G0 X${ctx.safeX} Y${ctx.safeY} Z${ctx.safeZ}`);
  return gcode;
}

// ============================================================
// 3D CARVING (Surface Machining)
// ============================================================

function generateCarving3DGCode(data: ProjectData, op: Operation, ctx: OpContext): string[] {
  const gcode: string[] = [];
  const spindleCodes = getSpindleCodes(op.spindleId, ctx.machineConfig);
  const params = op.params.carving3d;
  const feed = op.params.feedRate || 200;
  const rpm = op.params.spindleSpeed || 12000;

  if (!params) {
    gcode.push('(NO 3D CARVING PARAMETERS DEFINED)');
    return gcode;
  }

  gcode.push(formatTool(op.toolNumber));
  gcode.push('');
  gcode.push(`G0 X${ctx.safeX} Y${ctx.safeY} Z${ctx.safeZ}`);
  gcode.push(`${spindleCodes.start} S${rpm}`);
  gcode.push(ctx.machineConfig?.auxCodes?.dustOn ?? 'M76');
  gcode.push('');

  gcode.push(`(3D CARVING - ${params.finishingStrategy.toUpperCase()} STRATEGY)`);
  gcode.push(`(SCALLOP HEIGHT: ${fmt(params.scallopHeight, 2)}mm)`);
  gcode.push(`(STEPDOWN: ${fmt(params.stepdown, 1)}mm)`);
  gcode.push('');

  // Tool compensation for ball nose
  if (op.compensationMode === 'left') gcode.push(`G41 D${op.toolNumber.toString().padStart(2,'0')}`);
  else if (op.compensationMode === 'right') gcode.push(`G42 D${op.toolNumber.toString().padStart(2,'0')}`);

  // 3D carving uses the toolpath directly — the toolpath engine (Phase 4A)
  // generates the actual surface-following points with proper ball-nose compensation
  if (data.toolpath && data.toolpath.length > 0) {
    let lastA = 0;

    for (const point of data.toolpath) {
      const xDia = Math.abs(point.x) * 2; // Convert radius to diameter
      const y = point.y;
      const z = point.z;
      const a = point.a;

      if (point.moveType === 'rapid') {
        gcode.push(`G0 X${fmt(xDia)} Y${fmt(y)} Z${fmt(z)} A${fmt(a, 1)}`);
      } else if (point.moveType === 'arc_cw') {
        gcode.push(`G02 X${fmt(xDia)} Y${fmt(y)} Z${fmt(z)} A${fmt(a, 1)} F${fmt(feed, 0)}`);
      } else if (point.moveType === 'arc_ccw') {
        gcode.push(`G03 X${fmt(xDia)} Y${fmt(y)} Z${fmt(z)} A${fmt(a, 1)} F${fmt(feed, 0)}`);
      } else {
        // Simultaneous 4-axis linear move
        let line = `G1 X${fmt(xDia)} Y${fmt(y)} Z${fmt(z)}`;
        if (Math.abs(a - lastA) > 0.01) {
          line += ` A${fmt(a, 1)}`;
        }
        line += ` F${fmt(feed, 0)}`;
        gcode.push(line);
      }
      lastA = a;
    }
  } else {
    gcode.push('(NO TOOLPATH DATA - use toolpath engine to generate 3D carving paths)');
  }

  if (op.compensationMode && op.compensationMode !== 'none') gcode.push('G40');
  gcode.push('');
  gcode.push(`${spindleCodes.stop}`);
  gcode.push(`G0 X${ctx.safeX} Y${ctx.safeY} Z${ctx.safeZ}`);
  return gcode;
}

// ============================================================
// SIMULTANEOUS 4-AXIS CONTOURING
// ============================================================

function generateContouring4AxisGCode(data: ProjectData, op: Operation, ctx: OpContext): string[] {
  const gcode: string[] = [];
  const spindleCodes = getSpindleCodes(op.spindleId, ctx.machineConfig);
  const params = op.params.contouring4axis;
  const feed = op.params.feedRate || 200;
  const rpm = op.params.spindleSpeed || 12000;

  if (!params) {
    gcode.push('(NO 4-AXIS CONTOURING PARAMETERS DEFINED)');
    return gcode;
  }

  gcode.push(formatTool(op.toolNumber));
  gcode.push('');
  gcode.push(`G0 X${ctx.safeX} Y${ctx.safeY} Z${ctx.safeZ}`);
  gcode.push(`${spindleCodes.start} S${rpm}`);
  gcode.push(ctx.machineConfig?.auxCodes?.dustOn ?? 'M76');
  gcode.push('');

  gcode.push(`(4-AXIS CONTOURING - ${params.patternType.toUpperCase()})`);

  // For inverse time feed mode (needed when A-axis moves simultaneously)
  const useInverseTime = params.feedMode === 'inverse_time';
  if (useInverseTime) {
    gcode.push('G93'); // Inverse time feed mode
  }

  if (data.toolpath && data.toolpath.length > 0) {
    for (const point of data.toolpath) {
      const xDia = Math.abs(point.x) * 2;
      const y = point.y;
      const z = point.z;
      const a = point.a;

      if (point.moveType === 'rapid') {
        gcode.push(`G0 X${fmt(xDia)} Y${fmt(y)} Z${fmt(z)} A${fmt(a, 1)}`);
      } else {
        // Simultaneous 4-axis move with all axes
        const f = useInverseTime ? (point.feedRate || 1.0) : feed;
        gcode.push(`G1 X${fmt(xDia)} Y${fmt(y)} Z${fmt(z)} A${fmt(a, 1)} F${fmt(f, useInverseTime ? 4 : 0)}`);
      }
    }
  } else {
    gcode.push('(NO TOOLPATH DATA - use 4-axis interpolator to generate paths)');
  }

  if (useInverseTime) {
    gcode.push('G94'); // Back to feed per minute mode
  }

  gcode.push('');
  gcode.push(`${spindleCodes.stop}`);
  gcode.push(`G0 X${ctx.safeX} Y${ctx.safeY} Z${ctx.safeZ}`);
  return gcode;
}

// ============================================================
// MILLING (Generic non-indexed)
// ============================================================

function generateMillingGCode(data: ProjectData, op: Operation, ctx: OpContext): string[] {
  const gcode: string[] = [];
  const spindleCodes = getSpindleCodes(op.spindleId, ctx.machineConfig);

  gcode.push(formatTool(op.toolNumber));
  gcode.push('');
  gcode.push(`G0 X${ctx.safeX} Y${ctx.safeY} Z${ctx.safeZ}`);
  gcode.push(`${spindleCodes.start} S${op.params.spindleSpeed || 12000}`);
  gcode.push('');

  // Static or simultaneous milling uses toolpath directly
  if (data.toolpath && data.toolpath.length > 0) {
    for (const point of data.toolpath) {
      const xDia = Math.abs(point.x) * 2;
      if (point.moveType === 'rapid') {
        gcode.push(`G0 X${fmt(xDia)} Y${fmt(point.y)} Z${fmt(point.z)}`);
      } else {
        gcode.push(`G1 X${fmt(xDia)} Y${fmt(point.y)} Z${fmt(point.z)} F${fmt(op.params.feedRate || 200, 0)}`);
      }
    }
  }

  gcode.push(`${spindleCodes.stop}`);
  gcode.push(`G0 X${ctx.safeX} Y${ctx.safeY} Z${ctx.safeZ}`);
  return gcode;
}

// ============================================================
// PROFILE GENERATION (from toolpath)
// ============================================================

function generateProfileFromToolpath(
  toolpath: ToolpathPoint[],
  feedRate: number,
  stockLength: number,
  stockDiameter: number,
  diameterOffset: number = 0,
  reverse: boolean = false
): string[] {
  const gcode: string[] = [];
  if (toolpath.length === 0) return gcode;

  const radiusValues = toolpath.map(p => getRadius(p));
  const maxRadius = Math.max(...radiusValues);
  const maxDiameter = maxRadius * 2;

  // Group points by Z position
  const zLevels = new Map<number, number>();
  for (const point of toolpath) {
    const z = Math.round(point.z * 10) / 10;
    const radius = getRadius(point);
    if (!zLevels.has(z)) {
      zLevels.set(z, radius);
    } else {
      const existing = zLevels.get(z)!;
      if (radius < existing && radius > 0.5) {
        zLevels.set(z, radius);
      }
    }
  }

  const sortedZLevels = Array.from(zLevels.entries())
    .sort((a, b) => reverse ? a[0] - b[0] : b[0] - a[0]);

  if (!reverse) {
    const startDiameter = maxDiameter - 0.036 - diameterOffset;
    gcode.push(`G0X${fmt(startDiameter)}Z0.000Z0`);
    gcode.push(`G1Z0 F${fmt(feedRate, 1)}`);
  }

  let lastRadius = reverse ? 0 : maxDiameter / 2;
  let lastZ = reverse ? -stockLength : 0;
  let isFirst = true;

  for (const [z, radius] of sortedZLevels) {
    const xDiameter = radius * 2 - diameterOffset;
    const zNeg = z <= 0 ? z : -z;
    if (Math.abs(zNeg) > stockLength) continue;

    if (reverse && isFirst) {
      gcode.push(`G1X${fmt(xDiameter)}Z${fmt(zNeg)} F${fmt(feedRate, 1)}`);
      isFirst = false;
    } else if (Math.abs(xDiameter - (lastRadius * 2 - diameterOffset)) > 0.001 || Math.abs(zNeg - lastZ) > 0.001) {
      gcode.push(`X${fmt(xDiameter)}Z${fmt(zNeg)}`);
    }

    lastRadius = radius;
    lastZ = zNeg;
  }

  return gcode;
}

// ============================================================
// LEGACY TURNING WORKFLOW (backwards compatibility)
// ============================================================

function generateLegacyTurningWorkflow(data: ProjectData, ctx: {
  safeX: number; safeY: number; stockLength: number; stockDiameter: number;
  cuttingFeed: number; spindleRPM: number; singleRoughingPass: boolean;
  knifeToolNumber: number; sandingToolNumber: number;
  paddleOffset: number; sandingRPM: number; sandingFeed: number;
}): string[] {
  const gcode: string[] = [];

  const minProfileRadius = Math.min(...data.toolpath.map(p => getRadius(p)));
  const roughTargetDiameter = minProfileRadius * 2 + 2;
  const roughingOp = data.operations?.find(op => op.type === 'roughing' || op.type === 'turning');
  const actualSpindleRPM = roughingOp?.params?.spindleSpeed ?? ctx.spindleRPM;
  const actualCuttingFeed = roughingOp?.params?.feedRate ?? ctx.cuttingFeed;

  gcode.push('G0Z0');
  gcode.push(`G0X${ctx.safeX} Z0 Y${ctx.safeY.toFixed(1)}`);
  gcode.push(`M03 S${actualSpindleRPM}`);
  gcode.push('M76');
  gcode.push('');

  if (ctx.singleRoughingPass) {
    gcode.push(`G0X${roughTargetDiameter.toFixed(3)} Z0`);
    gcode.push(`G1Z-${ctx.stockLength.toFixed(1)} F${actualCuttingFeed.toFixed(0)}`);
    gcode.push(`G0X${ctx.safeX}`);
  } else {
    const depthPerPass = 3;
    let currentDiameter = ctx.stockDiameter;
    while (currentDiameter > roughTargetDiameter) {
      currentDiameter = Math.max(currentDiameter - depthPerPass * 2, roughTargetDiameter);
      gcode.push(`G0X${ctx.safeX} Z0`);
      gcode.push(`G0X${currentDiameter.toFixed(3)} Z0`);
      gcode.push(`G1Z-${ctx.stockLength.toFixed(1)} F${actualCuttingFeed.toFixed(0)}`);
      gcode.push(`G0X${ctx.safeX}`);
    }
  }
  gcode.push(`G0 X${ctx.safeX} Z0`);
  gcode.push('');

  // Knife pass
  gcode.push(formatTool(ctx.knifeToolNumber));
  gcode.push('');
  gcode.push(`G0 X${ctx.safeX} Z0`);
  gcode.push('G0Z0');
  gcode.push(`G0X${ctx.safeX} Z0`);

  const profileGcode = generateProfileFromToolpath(data.toolpath, ctx.cuttingFeed, ctx.stockLength, ctx.stockDiameter, 0);
  gcode.push(...profileGcode);

  // Sanding
  const hasSanding = data.operations?.some(op => op.type === 'sanding') ?? true;
  if (hasSanding) {
    const sandingOp = data.operations?.find(op => op.type === 'sanding');
    const actualPaddleOffset = sandingOp?.params?.paddleOffset ?? ctx.paddleOffset;
    const actualSandingFeed = sandingOp?.params?.feedRate ?? ctx.sandingFeed;
    const actualSandingTool = sandingOp?.toolNumber ?? ctx.sandingToolNumber;

    gcode.push('');
    gcode.push(formatTool(ctx.knifeToolNumber));
    gcode.push('');
    gcode.push(formatTool(actualSandingTool));
    gcode.push('');

    const sandingGcode = generateProfileFromToolpath(
      data.toolpath, actualSandingFeed, ctx.stockLength, ctx.stockDiameter,
      actualPaddleOffset * 2, true
    );
    gcode.push(...sandingGcode);
    gcode.push('');
    gcode.push(`G0X${ctx.safeX} Z0`);
  } else {
    gcode.push('');
    gcode.push('G0Z0');
    gcode.push(`G0X${ctx.safeX} Z0`);
  }

  return gcode;
}

// ============================================================
// INDEXED MILLING JOB (full job wrapper)
// ============================================================

function generateIndexedMillingJob(
  data: ProjectData,
  options: {
    projectName?: string;
    stockLength?: number;
    safeX?: number;
    safeY?: number;
    machineConfig?: MachineConfig;
  } = {}
): string {
  const gcode: string[] = [];
  const {
    projectName = "Indexed Milling Job",
    stockLength = data.stock?.length || 200,
    safeX = 100,
    safeY = 75,
    machineConfig,
  } = options;

  const quantity = data.quantity || 1;
  const loader = machineConfig?.loaderCodes;

  gcode.push(projectName);
  gcode.push('');
  gcode.push('T0909');
  gcode.push('T0202');
  gcode.push('');
  gcode.push('T0707');
  gcode.push('');

  for (let pieceNum = 1; pieceNum <= quantity; pieceNum++) {
    if (quantity > 1) {
      gcode.push(`(PIECE ${pieceNum} OF ${quantity})`);
      gcode.push('');
    }

    gcode.push(loader?.release ?? 'M69');
    gcode.push(loader?.start ?? 'M70');
    gcode.push(loader?.position ?? 'M71');
    gcode.push(loader?.complete ?? 'M72');
    gcode.push('');
    gcode.push(loader?.clamp ?? 'M68');
    gcode.push('');

    const indexedOps = data.operations?.filter(op => op.rotationMode === 'indexed') || [];
    for (const op of indexedOps) {
      const opGcode = generateIndexedMillingGCode(data, op, { safeX, safeY, safeZ: 50 });
      gcode.push(...opGcode);
    }

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

    gcode.push('');
    gcode.push('M05');
    gcode.push(machineConfig?.auxCodes?.dustOff ?? 'M77');
    gcode.push('');
    gcode.push('T0707');
    gcode.push('');
    gcode.push('T0202');
    gcode.push('');
  }

  gcode.push(machineConfig?.postProcessor?.programEnd ?? 'M30');
  return gcode.join('\n');
}

// ============================================================
// INDEXED MILLING (per-operation)
// ============================================================

export function generateIndexedMillingGCode(
  data: ProjectData,
  operation: Operation,
  options: { safeX?: number; safeY?: number; safeZ?: number } = {}
): string[] {
  const gcode: string[] = [];
  const { safeX = 100, safeY = 75, safeZ = 50 } = options;

  const stockLength = data.stock?.length || 200;
  const stockDiameter = data.stock?.diameter || 100;
  const stockRadius = stockDiameter / 2;

  const feedRate = operation.params.feedRate || 200;
  const spindleRPM = operation.params.spindleSpeed || 2100;
  const depthOfCut = operation.params.depthOfCut || 2;
  const indexCount = operation.params.indexCount || 4;
  const indexAngle = operation.params.indexAngle || (360 / indexCount);

  gcode.push(`(INDEXED MILLING - ${indexCount} FLAT SIDES)`);
  gcode.push(`(STOCK: ${stockDiameter}mm DIA x ${stockLength}mm LENGTH)`);
  gcode.push('');
  gcode.push(formatTool(operation.toolNumber));
  gcode.push('');
  gcode.push(`G0 X${safeX} Y${safeY} Z${safeZ}`);
  gcode.push(`M03 S${spindleRPM}`);
  gcode.push('M76');
  gcode.push('');

  if (!data.toolpath || data.toolpath.length === 0) {
    gcode.push('(NO TOOLPATH DATA)');
    return gcode;
  }

  // Build profile
  const zLevels = new Map<number, number>();
  for (const point of data.toolpath) {
    const z = Math.round(point.z * 10) / 10;
    const radius = getRadius(point);
    if (!zLevels.has(z) || radius < zLevels.get(z)!) {
      zLevels.set(z, radius);
    }
  }

  const sortedProfile = Array.from(zLevels.entries()).sort((a, b) => b[0] - a[0]);
  const profileRadii = Array.from(zLevels.values());
  const maxRemovalDepth = stockRadius - Math.min(...profileRadii);

  if (maxRemovalDepth <= 0) {
    gcode.push('(PROFILE LARGER THAN STOCK - NO CUTTING NEEDED)');
    return gcode;
  }

  for (let i = 0; i < indexCount; i++) {
    const currentAngle = i * indexAngle;
    gcode.push(`(SIDE ${i + 1} OF ${indexCount} - A${currentAngle.toFixed(1)} DEGREES)`);
    gcode.push(`G0 A${currentAngle.toFixed(1)}`);
    gcode.push('');

    const numPasses = Math.max(1, Math.ceil(maxRemovalDepth / depthOfCut));
    for (let pass = 1; pass <= numPasses; pass++) {
      const passRemovalMax = Math.min(pass * depthOfCut, maxRemovalDepth);
      gcode.push(`(PASS ${pass}/${numPasses})`);
      gcode.push(`G0 Z${safeZ}`);
      gcode.push(`G0 X${stockRadius.toFixed(3)} Y${safeY}`);
      gcode.push(`G0 Z0`);

      const firstProfileRadius = sortedProfile.find(([z]) => z === 0)?.[1] || sortedProfile[0][1];
      const firstDepth = Math.min(stockRadius - firstProfileRadius, passRemovalMax);
      gcode.push(`G1 Y${(-firstDepth).toFixed(3)} F${feedRate}`);

      for (const [z, profileRadius] of sortedProfile) {
        if (Math.abs(z) > stockLength || z > 0) continue;
        const actualDepth = Math.min(stockRadius - profileRadius, passRemovalMax);
        gcode.push(`G1 Y${(-actualDepth).toFixed(3)} Z${z.toFixed(3)}`);
      }

      gcode.push(`G0 Y${safeY}`);
      gcode.push(`G0 Z${safeZ}`);
      gcode.push('');
    }
  }

  gcode.push('G0 A0');
  gcode.push(`G0 X${safeX} Y${safeY} Z${safeZ}`);
  return gcode;
}

// ============================================================
// TURNING PROFILE SEGMENTS
// ============================================================

export function generateTurningProfile(
  segments: ProfileSegment[],
  options: { feedRate?: number; startDiameter?: number; stockLength?: number } = {}
): string[] {
  const { feedRate = 200, startDiameter = 50 } = options;
  const gcode: string[] = [];

  const approachDiam = startDiameter - 0.036;
  gcode.push(`G0X${approachDiam.toFixed(3)}Z0.000Z0`);
  gcode.push(`G1Z0 F${feedRate.toFixed(1)}`);

  for (const segment of segments) {
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
  x: number;
  z: number;
}

function generateSegmentPoints(segment: ProfileSegment): ProfilePoint[] {
  const points: ProfilePoint[] = [];
  const steps = 100;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const z = segment.startZ + (segment.endZ - segment.startZ) * t;
    let diameter: number;

    switch (segment.profileType) {
      case 'convex': {
        const bulge = Math.sin(t * Math.PI);
        const bulgeAmount = (segment.endDiameter - segment.startDiameter) / 2;
        diameter = segment.startDiameter + (segment.endDiameter - segment.startDiameter) * t + bulge * bulgeAmount;
        break;
      }
      case 'concave': {
        const indent = Math.sin(t * Math.PI);
        diameter = segment.startDiameter + (segment.endDiameter - segment.startDiameter) * t - indent * 5;
        break;
      }
      case 'bead': {
        const beadCurve = Math.sin(t * Math.PI);
        const maxBead = Math.max(segment.startDiameter, segment.endDiameter);
        diameter = Math.min(segment.startDiameter, segment.endDiameter) + beadCurve * (maxBead - Math.min(segment.startDiameter, segment.endDiameter));
        break;
      }
      case 'linear':
      default:
        diameter = segment.startDiameter + (segment.endDiameter - segment.startDiameter) * t;
    }

    points.push({ x: diameter, z });
  }
  return points;
}

// ============================================================
// SANDING (standalone)
// ============================================================

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
  gcode.push(formatTool(toolNumber));
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

// ============================================================
// G-CODE PARSER (import existing G-code)
// ============================================================

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

    const xMatch = trimmed.match(/X(-?\d+\.?\d*)/i);
    const yMatch = trimmed.match(/Y(-?\d+\.?\d*)/i);
    const zMatch = trimmed.match(/Z(-?\d+\.?\d*)/i);
    const aMatch = trimmed.match(/A(-?\d+\.?\d*)/i);
    const fMatch = trimmed.match(/F(\d+\.?\d*)/i);

    if (xMatch) currentX = parseFloat(xMatch[1]) / 2; // Diameter to radius
    if (yMatch) currentY = parseFloat(yMatch[1]);
    if (zMatch) currentZ = parseFloat(zMatch[1]);
    if (aMatch) currentA = parseFloat(aMatch[1]);
    if (fMatch) currentFeed = parseFloat(fMatch[1]);

    // Determine move type
    let moveType: ToolpathPoint['moveType'] = 'linear';
    if (trimmed.startsWith('G0 ') || trimmed.startsWith('G00') || (trimmed.startsWith('G0') && !trimmed.startsWith('G01') && !trimmed.startsWith('G02') && !trimmed.startsWith('G03'))) {
      moveType = 'rapid';
    } else if (trimmed.startsWith('G02') || trimmed.startsWith('G2 ')) {
      moveType = 'arc_cw';
    } else if (trimmed.startsWith('G03') || trimmed.startsWith('G3 ')) {
      moveType = 'arc_ccw';
    }

    const isMotionCommand = trimmed.match(/^G0[0-3]?\s/i) || trimmed.match(/^[XYZA]/i);
    const hasCoordinates = xMatch || yMatch || zMatch || aMatch;

    if (isMotionCommand && hasCoordinates) {
      toolpath.push({
        x: currentX,
        y: currentY,
        z: currentZ,
        a: currentA,
        feedRate: currentFeed,
        moveType,
      });
    }
  }

  return toolpath;
}
