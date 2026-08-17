import {
  ProjectData, ToolpathPoint, Operation, MachineConfig, SpindleConfig,
  ProfileSegment3D, Point3D, Tool,
  DrillingParams, GroovingParams, ThreadingParams, PlaningParams,
  EngravingParams, Carving3DParams, Contouring4AxisParams,
  getToolCylinderCodes
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
  /** Tool library rows — geometry + wear offsets are applied to emitted coordinates */
  tools?: Tool[];
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

/** Largest profile radius in a toolpath (loop, not spread — large meshes overflow the call stack) */
function maxProfileRadius(toolpath: ToolpathPoint[]): number {
  let max = 0;
  for (const p of toolpath) {
    const r = getRadius(p);
    if (r > max) max = r;
  }
  return max;
}


/** Format a number to fixed decimal, trimming trailing zeros */
function fmt(n: number, decimals: number = 3): string {
  return n.toFixed(decimals);
}

/** Combined geometry + wear offset for one tool. x is on the DIAMETER (same
 * axis convention as programmed X words); z shifts along the bed. */
export interface ToolOffset { x: number; z: number; }

/** Build toolNumber → combined offset map from tool library rows */
function buildToolOffsets(tools?: Tool[]): Map<number, ToolOffset> {
  const map = new Map<number, ToolOffset>();
  for (const tool of tools ?? []) {
    const o = (tool.params as any)?.offsets;
    if (!o) continue;
    const x = (Number(o.offsetX) || 0) + (Number(o.wearOffsetX) || 0);
    const z = (Number(o.offsetZ) || 0) + (Number(o.wearOffsetZ) || 0);
    if (x !== 0 || z !== 0) map.set(tool.toolNumber, { x, z });
  }
  return map;
}

const ZERO_OFFSET: ToolOffset = { x: 0, z: 0 };

/** Offset for an operation's tool (zero if none configured) */
function opOffset(op: Operation, ctx: OpContext): ToolOffset {
  return ctx.toolOffsets?.get(op.toolNumber) ?? ZERO_OFFSET;
}

/**
 * Wrap an operation's G-code with tool cylinder pneumatics: the engage
 * M-code goes right after the Ttttt select, the disengage M-code after the
 * operation finishes (even engages, engage+1 disengages).
 */
function withToolCylinder(lines: string[], toolNumber: number, config?: MachineConfig): string[] {
  const codes = getToolCylinderCodes(toolNumber, config);
  if (!codes) return lines;
  // A body that is only comments/blank lines (e.g. a skipped operation)
  // gets no cylinder actuation — don't cycle pneumatics for a no-op
  const hasMotion = lines.some(l => {
    const t = l.trim();
    return t && !t.startsWith('(');
  });
  if (!hasMotion) return lines;
  const out = [...lines];
  const tIdx = out.findIndex(l => /^T\d{4}$/.test(l.trim()));
  if (tIdx >= 0) out.splice(tIdx + 1, 0, codes.engage);
  else out.unshift(codes.engage);
  out.push(codes.disengage);
  return out;
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
    tools,
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

  // A profile toolpath is only required for profile-following operations
  // (roughing/turning/sanding) — drilling, grooving, threading, planing
  // jobs are fully described by their own parameters.
  const hasProfile = !!(data?.toolpath && data.toolpath.length > 0);
  if (!data || (!hasProfile && !(data.operations && data.operations.length > 0))) {
    return "No toolpath data";
  }

  const gcode: string[] = [];
  const stockDiameter = data.stock?.diameter || 100;
  const quantity = data.quantity || 1;
  const toolOffsets = buildToolOffsets(tools);

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

  // === POST-PROCESSOR PREAMBLE ===
  const post = machineConfig?.postProcessor;
  gcode.push(post?.units === 'imperial' ? 'G20' : 'G21');
  if (post?.coordinateSystem) gcode.push(post.coordinateSystem);
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
    // NOTE: M68-M72 were previously emitted here as a "loader sequence" but
    // on the Catek control those codes engage/disengage tool cylinders 12,
    // 1 and 2 — so no loader codes are emitted. Load and clamp the piece
    // manually (or add verified loader codes here once known).
    gcode.push('(LOAD AND CLAMP PIECE)');
    gcode.push('');

    // Process each operation in order
    if (data.operations && data.operations.length > 0) {
      for (const op of data.operations) {
        const opGcode = generateOperationGCode(data, op, {
          safeX, safeY, safeZ: machineConfig?.safeZ ?? 50,
          stockLength, stockDiameter, machineConfig, toolOffsets,
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
        paddleOffset, sandingRPM, sandingFeed, machineConfig, toolOffsets,
      });
      gcode.push(...legacyGcode);
    }

    // === END OF PIECE ===
    gcode.push('');
    gcode.push('M05');
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
  toolOffsets?: Map<number, ToolOffset>;
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

  let body: string[];
  switch (op.type) {
    case 'roughing':
      body = generateRoughingGCode(data, op, ctx); break;
    case 'turning':
    case 'finishing':
      body = generateTurningGCode(data, op, ctx); break;
    case 'sanding':
      body = generateSandingOpGCode(data, op, ctx); break;
    case 'milling':
    case 'routing':
      body = op.rotationMode === 'indexed'
        ? generateIndexedMillingGCode(data, op, { safeX: ctx.safeX, safeY: ctx.safeY, safeZ: ctx.safeZ })
        : generateMillingGCode(data, op, ctx);
      break;
    case 'drilling':
      body = generateDrillingGCode(data, op, ctx); break;
    case 'grooving':
      body = generateGroovingGCode(data, op, ctx); break;
    case 'threading':
      body = generateThreadingGCode(data, op, ctx); break;
    case 'planing':
      body = generatePlaningGCode(data, op, ctx); break;
    case 'engraving':
      body = generateEngravingGCode(data, op, ctx); break;
    case 'carving_3d':
      body = generateCarving3DGCode(data, op, ctx); break;
    case 'contouring_4axis':
      body = generateContouring4AxisGCode(data, op, ctx); break;
    default:
      gcode.push(`(UNSUPPORTED OPERATION: ${op.type})`);
      return gcode;
  }

  return [...gcode, ...withToolCylinder(body, op.toolNumber, ctx.machineConfig)];
}

// ============================================================
// ROUGHING
// ============================================================

function generateRoughingGCode(data: ProjectData, op: Operation, ctx: OpContext): string[] {
  const gcode: string[] = [];
  if (!data.toolpath || data.toolpath.length === 0) {
    // Without a profile the rough target would compute as ~0 diameter
    gcode.push('(ROUGHING SKIPPED: no profile toolpath - import geometry first)');
    return gcode;
  }
  const spindleCodes = getSpindleCodes(op.spindleId, ctx.machineConfig);
  const rpm = op.params.spindleSpeed || ctx.spindleRPM;
  const feed = op.params.feedRate || ctx.cuttingFeed;
  const depthPerPass = op.params.depthOfCut || 3;

  // Rough down to just above the LARGEST profile diameter: a straight
  // full-length pass any deeper would gouge sections of the part that stay
  // fat. The finishing pass then follows the actual profile.
  const off = opOffset(op, ctx);
  const roughTargetDiameter = maxProfileRadius(data.toolpath) * 2 + (op.params.allowance ?? 2) + off.x;

  gcode.push(formatTool(op.toolNumber));
  gcode.push('');
  gcode.push('G0Z0');
  gcode.push(`G0X${ctx.safeX} Z0 Y${ctx.safeY}`);
  gcode.push(`${spindleCodes.start} S${rpm}`);
  gcode.push('');

  // Tool compensation
  if (op.compensationMode === 'left') gcode.push(`G41 D${op.toolNumber.toString().padStart(2,'0')}`);
  else if (op.compensationMode === 'right') gcode.push(`G42 D${op.toolNumber.toString().padStart(2,'0')}`);

  const roughEndZ = -ctx.stockLength + off.z;
  if (ctx.singleRoughingPass || depthPerPass * 2 >= (ctx.stockDiameter - roughTargetDiameter)) {
    gcode.push(`G0X${fmt(roughTargetDiameter)} Z0`);
    gcode.push(`G1Z${fmt(roughEndZ, 1)} F${fmt(feed, 0)}`);
    gcode.push(`G0X${ctx.safeX}`);
  } else {
    let currentDiameter = ctx.stockDiameter;
    while (currentDiameter > roughTargetDiameter) {
      currentDiameter = Math.max(currentDiameter - depthPerPass * 2, roughTargetDiameter);
      gcode.push(`G0X${ctx.safeX} Z0`);
      gcode.push(`G0X${fmt(currentDiameter)} Z0`);
      gcode.push(`G1Z${fmt(roughEndZ, 1)} F${fmt(feed, 0)}`);
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
  if (!data.toolpath || data.toolpath.length === 0) {
    gcode.push('(TURNING SKIPPED: no profile toolpath - import geometry first)');
    return gcode;
  }
  const spindleCodes = getSpindleCodes(op.spindleId, ctx.machineConfig);
  const feed = op.params.feedRate || ctx.cuttingFeed;

  gcode.push(formatTool(op.toolNumber));
  gcode.push('');
  gcode.push(`G0 X${ctx.safeX} Z0`);
  gcode.push(`${spindleCodes.start} S${op.params.spindleSpeed || ctx.spindleRPM}`);
  gcode.push('');

  if (op.compensationMode === 'left') gcode.push(`G41 D${op.toolNumber.toString().padStart(2,'0')}`);
  else if (op.compensationMode === 'right') gcode.push(`G42 D${op.toolNumber.toString().padStart(2,'0')}`);

  const profileGcode = generateProfileFromToolpath(
    data.toolpath, feed, ctx.stockLength, ctx.stockDiameter, 0, false, opOffset(op, ctx)
  );
  gcode.push(...profileGcode);

  if (op.compensationMode && op.compensationMode !== 'none') gcode.push('G40');
  return gcode;
}

// ============================================================
// SANDING
// ============================================================

function generateSandingOpGCode(data: ProjectData, op: Operation, ctx: OpContext): string[] {
  const gcode: string[] = [];
  if (!data.toolpath || data.toolpath.length === 0) {
    gcode.push('(SANDING SKIPPED: no profile toolpath - import geometry first)');
    return gcode;
  }
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
    true,
    opOffset(op, ctx)
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
  gcode.push('');

  const retract = params.retractHeight || 2;
  const holeDepth = params.holeDepth;
  const peckDepth = params.peckDepth || holeDepth;

  // X is diameter mode: a radial depth of holeDepth needs 2x on the X word,
  // and the retract plane sits 2x the radial clearance above the surface.
  const drillOff = opOffset(op, ctx);
  const xBottom = ctx.stockDiameter - holeDepth * 2 + drillOff.x;
  const rPlane = ctx.stockDiameter + retract * 2;

  // Get hole positions
  const positions = params.holePattern?.positions || [{ x: 0, y: 0, z: -ctx.stockLength / 2 }];
  const indexAngles = params.holePattern?.indexAngles;

  // indexAngles is built as a PARALLEL array to positions (one angle per
  // hole). Pair them when the lengths match; otherwise fall back to drilling
  // every position at every angle.
  const holes: { angle: number; z: number }[] = [];
  if (indexAngles && indexAngles.length === positions.length) {
    positions.forEach((pos, i) => holes.push({ angle: indexAngles[i], z: pos.z + drillOff.z }));
  } else {
    for (const angle of indexAngles || [0]) {
      for (const pos of positions) holes.push({ angle, z: pos.z + drillOff.z });
    }
  }

  const usesAAxis = holes.some(h => h.angle !== 0);
  let lastAngle: number | null = null;

  for (const hole of holes) {
    if (usesAAxis && hole.angle !== lastAngle) {
      gcode.push(`(A-AXIS ${hole.angle}°)`);
      gcode.push(`G0 A${fmt(hole.angle, 1)}`);
      lastAngle = hole.angle;
    }

    // Position at the retract plane above the hole
    gcode.push(`G0 X${fmt(rPlane)} Z${fmt(hole.z)}`);

    if (params.drillCycle === 'spot') {
      // G81 spot drill
      gcode.push(`G81 X${fmt(xBottom)} Z${fmt(hole.z)} R${fmt(rPlane)} F${fmt(feed, 0)}`);
    } else {
      // G83 peck drill (standard and deep peck)
      gcode.push(`G83 X${fmt(xBottom)} Z${fmt(hole.z)} R${fmt(rPlane)} Q${fmt(peckDepth)} F${fmt(feed, 0)}`);
    }
  }

  gcode.push('G80'); // Cancel canned cycle
  gcode.push(`G0 X${ctx.safeX} Z${ctx.safeZ}`);
  if (usesAAxis) gcode.push('G0 A0');
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
  const grooveOff = opOffset(op, ctx);
  const targetDiameter = ctx.stockDiameter - params.grooveDepth * 2 + grooveOff.x;

  for (let i = 0; i < params.zPositions.length; i++) {
    const z = params.zPositions[i] + grooveOff.z;
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
      // Round groove: follow the semicircular cross-section with short
      // linear moves (tessellated — the old G03 pair had bogus I/K centers)
      const arcRadius = params.grooveDepth;
      gcode.push(`G0 X${fmt(ctx.stockDiameter + 1)} Z${fmt(z - arcRadius)}`);
      gcode.push(`G1 X${fmt(ctx.stockDiameter)} Z${fmt(z - arcRadius)} F${fmt(feed, 0)}`);
      const grooveSteps = 12;
      for (let s = 1; s <= grooveSteps; s++) {
        const theta = (s / grooveSteps) * Math.PI; // 0..180° across the groove
        const xDia = ctx.stockDiameter - 2 * arcRadius * Math.sin(theta);
        const zPos = z - arcRadius * Math.cos(theta);
        gcode.push(`G1 X${fmt(Math.max(xDia, targetDiameter))} Z${fmt(zPos)}`);
      }
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

  const threadOff = opOffset(op, ctx);
  let finalDiameter: number;
  let approachX: number;
  if (isExternal) {
    // External: thread minor diameter = OD minus twice the depth
    finalDiameter = stockDia - params.threadDepth * 2 + threadOff.x;
    approachX = stockDia + 5;
  } else {
    // Internal: threads cut OUTWARD from a pre-drilled bore. Without the
    // bore diameter there is no valid geometry — refuse to guess.
    if (!params.boreDiameter || params.boreDiameter <= 0) {
      gcode.push('(INTERNAL THREAD SKIPPED: boreDiameter not set)');
      gcode.push('(Set the pre-drilled bore diameter in the threading parameters)');
      return gcode;
    }
    finalDiameter = params.boreDiameter + params.threadDepth * 2 + threadOff.x;
    // Approach inside the bore, clear of the wall
    approachX = Math.max(params.boreDiameter - 2, 1);
  }

  gcode.push(`(${params.threadForm.toUpperCase()} THREAD - ${params.pitch}mm PITCH)`);
  gcode.push(`(${isExternal ? 'EXTERNAL' : 'INTERNAL'} - DEPTH ${params.threadDepth}mm)`);
  gcode.push('');

  // Position at start
  gcode.push(`G0 X${fmt(approachX)} Z${fmt(params.startZ + 5 + threadOff.z)}`);

  // First G76 line: spring passes, chamfer, angle, min depth, finish allowance
  gcode.push(`G76 P${springStr}${chamferStr}${angleStr} Q${minCutMicrons} R${finishAllowance}`);
  // Second G76 line: final diameter, end Z, depth, first cut depth, pitch
  gcode.push(`G76 X${fmt(finalDiameter)} Z${fmt(params.endZ + threadOff.z)} P${depthMicrons} Q${firstCutMicrons} F${fmt(params.pitch)}`);
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
  gcode.push('');

  gcode.push(`(PLANING ${params.surfaceTarget.toUpperCase()} FACE - ${numPasses} PASSES)`);
  gcode.push(`(TOTAL REMOVAL: ${fmt(totalDepth, 1)}mm)`);
  gcode.push('');

  for (let pass = 1; pass <= numPasses; pass++) {
    const currentDepth = Math.min(pass * depthPerPass, totalDepth);

    gcode.push(`(PASS ${pass}/${numPasses} - DEPTH ${fmt(currentDepth, 1)}mm)`);
    // X word is diameter mode; approach with Y clear, feed-plunge to depth,
    // then feed the full length — never rapid while at cutting depth.
    if (params.passDirection === 'climb') {
      gcode.push(`G0 Y${ctx.safeY}`);
      gcode.push(`G0 X${fmt(ctx.stockDiameter)} Z0`);
      gcode.push(`G1 Y${fmt(-currentDepth)} F${fmt(feed * 0.5, 0)}`);
      gcode.push(`G1 Z-${fmt(ctx.stockLength)} F${fmt(feed, 0)}`);
    } else {
      gcode.push(`G0 Y${ctx.safeY}`);
      gcode.push(`G0 X${fmt(ctx.stockDiameter)} Z-${fmt(ctx.stockLength)}`);
      gcode.push(`G1 Y${fmt(-currentDepth)} F${fmt(feed * 0.5, 0)}`);
      gcode.push(`G1 Z0 F${fmt(feed, 0)}`);
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

  // Use toolpath data for engraving path if available.
  // The engraving engine maps text along Z with glyph height as A-axis
  // rotation; the tool plunges in Y. surfaceAngle orients the whole text.
  if (data.toolpath && data.toolpath.length > 0) {
    let penDown = false;

    for (const point of data.toolpath) {
      const a = params.surfaceAngle + (point.a || 0);

      if (point.moveType === 'rapid') {
        // Lift and reposition
        gcode.push(`G0 Y${ctx.safeY}`);
        gcode.push(`G0 Z${fmt(point.z)} A${fmt(a, 2)}`);
        penDown = false;
      } else {
        if (!penDown) {
          gcode.push(`G1 Y${fmt(-engravingDepth)} F${fmt(feed * 0.5, 0)}`); // Slow plunge
          penDown = true;
        }
        // Linear engraving stroke (arcs are pre-tessellated by the engine)
        gcode.push(`G1 Z${fmt(point.z)} A${fmt(a, 2)} F${fmt(feed, 0)}`);
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
  reverse: boolean = false,
  toolOffset: ToolOffset = ZERO_OFFSET
): string[] {
  const gcode: string[] = [];
  if (toolpath.length === 0) return gcode;

  const maxDiameter = maxProfileRadius(toolpath) * 2;

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
    const startDiameter = maxDiameter - 0.036 - diameterOffset + toolOffset.x;
    gcode.push(`G0X${fmt(startDiameter)}Z${fmt(toolOffset.z)}`);
    gcode.push(`G1Z${fmt(toolOffset.z)} F${fmt(feedRate, 1)}`);
  }

  let lastRadius = reverse ? 0 : maxDiameter / 2;
  let lastZ = reverse ? -stockLength : 0;
  let isFirst = true;

  for (const [z, radius] of sortedZLevels) {
    const xDiameter = radius * 2 - diameterOffset + toolOffset.x;
    const zNeg = (z <= 0 ? z : -z) + toolOffset.z;
    if (Math.abs(zNeg) > stockLength + Math.abs(toolOffset.z)) continue;

    if (reverse && isFirst) {
      gcode.push(`G1X${fmt(xDiameter)}Z${fmt(zNeg)} F${fmt(feedRate, 1)}`);
      isFirst = false;
    } else if (Math.abs(xDiameter - (lastRadius * 2 - diameterOffset + toolOffset.x)) > 0.001 || Math.abs(zNeg - lastZ) > 0.001) {
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
  machineConfig?: MachineConfig;
  toolOffsets?: Map<number, ToolOffset>;
}): string[] {
  const gcode: string[] = [];
  const knifeCyl = getToolCylinderCodes(ctx.knifeToolNumber, ctx.machineConfig);
  const knifeOff = ctx.toolOffsets?.get(ctx.knifeToolNumber) ?? ZERO_OFFSET;

  // Rough to just above the LARGEST profile diameter (see generateRoughingGCode)
  const roughTargetDiameter = maxProfileRadius(data.toolpath) * 2 + 2;
  const roughingOp = data.operations?.find(op => op.type === 'roughing' || op.type === 'turning');
  const actualSpindleRPM = roughingOp?.params?.spindleSpeed ?? ctx.spindleRPM;
  const actualCuttingFeed = roughingOp?.params?.feedRate ?? ctx.cuttingFeed;

  gcode.push('G0Z0');
  gcode.push(`G0X${ctx.safeX} Z0 Y${ctx.safeY.toFixed(1)}`);
  gcode.push(`M03 S${actualSpindleRPM}`);
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
  if (knifeCyl) gcode.push(knifeCyl.engage);
  gcode.push('');
  gcode.push(`G0 X${ctx.safeX} Z0`);
  gcode.push('G0Z0');
  gcode.push(`G0X${ctx.safeX} Z0`);

  const profileGcode = generateProfileFromToolpath(
    data.toolpath, ctx.cuttingFeed, ctx.stockLength, ctx.stockDiameter, 0, false, knifeOff
  );
  gcode.push(...profileGcode);
  if (knifeCyl) gcode.push(knifeCyl.disengage);

  // Sanding
  const hasSanding = data.operations?.some(op => op.type === 'sanding') ?? true;
  if (hasSanding) {
    const sandingOp = data.operations?.find(op => op.type === 'sanding');
    const actualPaddleOffset = sandingOp?.params?.paddleOffset ?? ctx.paddleOffset;
    const actualSandingFeed = sandingOp?.params?.feedRate ?? ctx.sandingFeed;
    const actualSandingTool = sandingOp?.toolNumber ?? ctx.sandingToolNumber;
    const sandCyl = getToolCylinderCodes(actualSandingTool, ctx.machineConfig);
    const sandOff = ctx.toolOffsets?.get(actualSandingTool) ?? ZERO_OFFSET;

    gcode.push('');
    gcode.push(formatTool(actualSandingTool));
    if (sandCyl) gcode.push(sandCyl.engage);
    gcode.push('');

    const sandingGcode = generateProfileFromToolpath(
      data.toolpath, actualSandingFeed, ctx.stockLength, ctx.stockDiameter,
      actualPaddleOffset * 2, true, sandOff
    );
    gcode.push(...sandingGcode);
    if (sandCyl) gcode.push(sandCyl.disengage);
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

    // M68-M72 are tool cylinder codes on the Catek control, not a loader
    // sequence — load and clamp manually (see gcode-generator main path).
    gcode.push('(LOAD AND CLAMP PIECE)');
    gcode.push('');

    const indexedOps = data.operations?.filter(op => op.rotationMode === 'indexed') || [];
    for (const op of indexedOps) {
      const opGcode = generateIndexedMillingGCode(data, op, { safeX, safeY, safeZ: 50 });
      gcode.push(...withToolCylinder(opGcode, op.toolNumber, machineConfig));
    }

    const sandingOps = data.operations?.filter(op => op.type === 'sanding') || [];
    for (const op of sandingOps) {
      const sandGcode: string[] = [];
      sandGcode.push('');
      sandGcode.push(`(SANDING)`);
      sandGcode.push(formatTool(op.toolNumber));
      sandGcode.push('');
      sandGcode.push(`M03 S${op.params.spindleSpeed || 2400}`);
      sandGcode.push(`G0 X${safeX} Y${safeY} Z0`);
      sandGcode.push(`G1 Z-${stockLength.toFixed(1)} F${op.params.feedRate || 1500}`);
      sandGcode.push(`G0 Z50`);
      gcode.push(...withToolCylinder(sandGcode, op.toolNumber, machineConfig));
    }

    gcode.push('');
    gcode.push('M05');
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

      const firstProfileRadius = sortedProfile.find(([z]) => Math.abs(z) < 0.05)?.[1] || sortedProfile[0][1];
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
  gcode.push(`G0X${approachDiam.toFixed(3)}Z0.000`);
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
    machineConfig?: MachineConfig;
  } = {}
): string[] {
  const gcode: string[] = [];
  const {
    toolNumber = 3,
    sandingRPM = 2400,
    sandingFeed = 1500,
    passes = 2,
    contactPressure = 0.5,
    machineConfig,
  } = options;
  const cyl = getToolCylinderCodes(toolNumber, machineConfig);

  const stockDiameter = data.stock?.diameter || 100;
  const stockLength = data.stock?.length || 910;
  const safeX = stockDiameter + 10;
  const contactX = stockDiameter - contactPressure * 2;

  gcode.push('');
  gcode.push(formatTool(toolNumber));
  if (cyl) gcode.push(cyl.engage);
  gcode.push(`G0 X${safeX.toFixed(1)}`);
  gcode.push('G0 Z10');
  gcode.push(`M03 S${sandingRPM}`);
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
  if (cyl) gcode.push(cyl.disengage);
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
  // G0/G1/G2/G3 are modal: bare coordinate lines continue the last motion mode
  let modalMoveType: ToolpathPoint['moveType'] = 'linear';

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

    // Motion G-word (with or without a following space, e.g. "G0X100" or "G1 Z-5").
    // (?!\d) keeps G40/G41/G42 etc. from matching as G4.
    const gMotion = trimmed.match(/^G0*([0-3])(?!\d)/i);
    if (gMotion) {
      switch (gMotion[1]) {
        case '0': modalMoveType = 'rapid'; break;
        case '1': modalMoveType = 'linear'; break;
        case '2': modalMoveType = 'arc_cw'; break;
        case '3': modalMoveType = 'arc_ccw'; break;
      }
    }

    // A line is a motion block if it starts a motion G-word or continues the
    // modal one with bare coordinates (X/Y/Z/A word first).
    const isMotionCommand = gMotion || /^[XYZA]-?\d/i.test(trimmed);
    const hasCoordinates = xMatch || yMatch || zMatch || aMatch;

    if (isMotionCommand && hasCoordinates) {
      toolpath.push({
        x: currentX,
        y: currentY,
        z: currentZ,
        a: currentA,
        feedRate: currentFeed,
        moveType: modalMoveType,
      });
    }
  }

  return toolpath;
}
