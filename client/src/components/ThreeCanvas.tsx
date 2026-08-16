import { useRef, useState, useMemo, useEffect } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Grid, PerspectiveCamera, Line, Text } from '@react-three/drei';
import * as THREE from 'three';
import type { MachineStock, ToolpathPoint, Tool, ImportedGeometry, Operation } from '@shared/schema';

interface ThreeCanvasProps {
  stock: MachineStock;
  toolpath: ToolpathPoint[];
  currentTool?: Tool;
  isSimulating: boolean;
  simulationProgress: number;
  onSimulationComplete?: () => void;
  /** Throttled live progress while simulating (drives the editor's slider) */
  onProgressUpdate?: (p: number) => void;
  className?: string;
  importedGeometry?: ImportedGeometry;
  operations?: Operation[];
}

// Convert machine coordinates to scene coordinates.
// Machine: X = radial, Y = vertical, Z = along bed (0 at spindle, negative
// toward tailstock). Scene: X = along bed (headstock at 0), Y = up, Z = radial.
function toScene(machineX: number, machineY: number, machineZ: number): [number, number, number] {
  return [
    -machineZ,
    machineY,
    machineX,
  ];
}

// Convert with A-axis rotation about the spindle axis (scene X).
// Matches the mesh rotation direction (rotation.x = +A): a right-handed
// rotation about +X takes +Y toward +Z. The previous version rotated the
// opposite way, so wrapped features displayed mirrored against the part.
function toSceneWithRotation(machineX: number, machineY: number, machineZ: number, machineA: number): [number, number, number] {
  const angleRad = (machineA * Math.PI) / 180;
  const rotatedY = machineY * Math.cos(angleRad) - machineX * Math.sin(angleRad);
  const rotatedZ = machineX * Math.cos(angleRad) + machineY * Math.sin(angleRad);
  return [-machineZ, rotatedY, rotatedZ];
}

// ============================================================
// DISTANCE-BASED PROGRESS
// ============================================================

/**
 * Cumulative XYZ distance at each toolpath point. The simulation advances
 * progress as a fraction of total distance, so rendering must interpret it
 * the same way — index-based lookup made the tool sprint through long moves
 * and crawl through dense ones.
 */
function cumulativeDistances(toolpath: ToolpathPoint[]): number[] {
  const cum: number[] = new Array(toolpath.length).fill(0);
  for (let i = 1; i < toolpath.length; i++) {
    const dx = toolpath[i].x - toolpath[i - 1].x;
    const dy = toolpath[i].y - toolpath[i - 1].y;
    const dz = toolpath[i].z - toolpath[i - 1].z;
    cum[i] = cum[i - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return cum;
}

/** Interpolated position along the path at a distance fraction [0..1] */
function interpolateAlongPath(
  toolpath: ToolpathPoint[],
  cum: number[],
  progress: number
): { point: ToolpathPoint; index: number } {
  const n = toolpath.length;
  if (n === 0) return { point: { x: 0, y: 0, z: 0, a: 0 }, index: 0 };
  if (n === 1 || progress <= 0) return { point: toolpath[0], index: 0 };

  const total = cum[n - 1] || 1;
  const target = Math.min(progress, 1) * total;

  // Binary search for the segment containing the target distance
  let lo = 0, hi = n - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= target) lo = mid;
    else hi = mid;
  }

  const p0 = toolpath[lo];
  const p1 = toolpath[hi];
  const segLen = cum[hi] - cum[lo];
  const t = segLen > 0.0001 ? (target - cum[lo]) / segLen : 1;

  return {
    point: {
      x: p0.x + (p1.x - p0.x) * t,
      y: p0.y + (p1.y - p0.y) * t,
      z: p0.z + (p1.z - p0.z) * t,
      a: (p0.a || 0) + ((p1.a || 0) - (p0.a || 0)) * t,
      moveType: p1.moveType,
    },
    index: hi,
  };
}

// ============================================================
// STOCK
// ============================================================

function Stock({
  stockType = 'round',
  diameter,
  width,
  height,
  length
}: {
  stockType?: 'round' | 'square';
  diameter: number;
  width?: number;
  height?: number;
  length: number;
}) {
  const stockWidth = width || diameter;
  const stockHeight = height || diameter;

  if (stockType === 'square') {
    return (
      <mesh position={[length / 2, 0, 0]}>
        <boxGeometry args={[length, stockHeight, stockWidth]} />
        <meshStandardMaterial color="#D2691E" transparent opacity={0.3} roughness={0.8} />
      </mesh>
    );
  }

  return (
    <mesh rotation={[0, 0, -Math.PI / 2]} position={[length / 2, 0, 0]}>
      <cylinderGeometry args={[diameter / 2, diameter / 2, length, 64]} />
      <meshStandardMaterial color="#D2691E" transparent opacity={0.3} roughness={0.8} />
    </mesh>
  );
}

// ============================================================
// WORKPIECE (turned profile)
// ============================================================

function Workpiece({
  toolpath,
  visibleCount,
  stockDiameter,
  stockLength,
  currentRotation,
  spinning,
}: {
  toolpath: ToolpathPoint[];
  visibleCount: number;
  stockDiameter: number;
  stockLength: number;
  currentRotation: number;
  spinning: boolean;
}) {
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame((_, delta) => {
    if (!meshRef.current) return;
    if (spinning) {
      // Cosmetic spindle rotation during turning simulation (~90 RPM visual)
      meshRef.current.rotation.x += delta * Math.PI * 3;
    } else {
      meshRef.current.rotation.x = (currentRotation * Math.PI) / 180;
    }
  });

  const geometry = useMemo(() => {
    if (toolpath.length < 2) return null;

    const visiblePoints = toolpath.slice(0, Math.max(visibleCount, 1) + 1);
    if (visiblePoints.length < 2) return null;

    const profileMap = new Map<number, number>();
    for (const p of visiblePoints) {
      const sceneX = -p.z;
      if (sceneX < 0 || sceneX > stockLength) continue;
      const radius = Math.sqrt(p.x * p.x + p.y * p.y);
      const currentMin = profileMap.get(Math.round(sceneX)) ?? stockDiameter / 2;
      profileMap.set(Math.round(sceneX), Math.min(currentMin, radius));
    }

    const sortedPositions = Array.from(profileMap.entries()).sort((a, b) => a[0] - b[0]);
    if (sortedPositions.length < 2) return null;

    const lathePoints = sortedPositions.map(([x, r]) => new THREE.Vector2(
      Math.max(r, 0.5), x
    ));

    const firstX = sortedPositions[0][0];
    const lastX = sortedPositions[sortedPositions.length - 1][0];
    if (firstX > 5) lathePoints.unshift(new THREE.Vector2(stockDiameter / 2, 0));
    if (lastX < stockLength - 5) lathePoints.push(new THREE.Vector2(stockDiameter / 2, stockLength));

    const latheGeometry = new THREE.LatheGeometry(lathePoints, 64, 0, Math.PI * 2);
    latheGeometry.rotateZ(-Math.PI / 2);
    return latheGeometry;
  }, [toolpath, visibleCount, stockDiameter, stockLength]);

  // Dispose old geometry on update
  const prevGeomRef = useRef<THREE.LatheGeometry | null>(null);
  useEffect(() => {
    if (prevGeomRef.current && prevGeomRef.current !== geometry) {
      prevGeomRef.current.dispose();
    }
    prevGeomRef.current = geometry;
    return () => { geometry?.dispose(); };
  }, [geometry]);

  if (!geometry) return null;

  return (
    <mesh ref={meshRef} geometry={geometry} position={[0, 0, 0]}>
      <meshStandardMaterial color="#8B4513" roughness={0.6} metalness={0.1} />
    </mesh>
  );
}

// ============================================================
// TYPE-SPECIFIC TOOL MODELS
// ============================================================

// All tool models are built in a local Y-up frame with the CUTTING TIP AT
// THE ORIGIN and the shank/holder extending in +Y. ToolVisual then orients
// the whole model to match how the tool actually mounts on the machine:
// lathe-type tools (knife, parting, threading, drill, sander) come at the
// part radially, spindle-type tools (router, V-bit, ball nose, planer)
// hang above it.

const STEEL = { color: '#8a8f98', metalness: 0.9, roughness: 0.35 };
const HOLDER = { color: '#3d4450', metalness: 0.7, roughness: 0.5 };
const CARBIDE = { color: '#c9a227', metalness: 0.8, roughness: 0.25 };
const HSS = { color: '#b8bec9', metalness: 0.95, roughness: 0.2 };

/** HSS turning knife: block holder, rectangular tool bit, ground tip wedge */
function TurningToolModel({ noseAngle = 55 }: { noseAngle?: number }) {
  const half = (noseAngle / 2) * (Math.PI / 180);
  return (
    <group>
      {/* Tool block clamped in the turret */}
      <mesh position={[0, 26, 0]}>
        <boxGeometry args={[14, 18, 14]} />
        <meshStandardMaterial {...HOLDER} />
      </mesh>
      {/* Clamp screws */}
      {[-4, 4].map(x => (
        <mesh key={x} position={[x, 26, 7.2]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[1.4, 1.4, 1.5, 12]} />
          <meshStandardMaterial {...STEEL} />
        </mesh>
      ))}
      {/* Rectangular tool bit */}
      <mesh position={[0, 10, 0]}>
        <boxGeometry args={[5, 16, 8]} />
        <meshStandardMaterial {...HSS} />
      </mesh>
      {/* Ground cutting wedge narrowing to the tip at the origin */}
      <mesh position={[0, 1.5, 0]} rotation={[0, 0, 0]}>
        <cylinderGeometry args={[0.3, 4 * Math.tan(half) + 1, 5, 4]} />
        <meshStandardMaterial {...HSS} />
      </mesh>
    </group>
  );
}

/** Parting / grooving blade: tall thin blade in a block holder */
function GroovingToolModel({ cutWidth = 3 }: { cutWidth?: number }) {
  const w = Math.max(cutWidth, 1.5);
  return (
    <group>
      <mesh position={[0, 28, 0]}>
        <boxGeometry args={[14, 16, 14]} />
        <meshStandardMaterial {...HOLDER} />
      </mesh>
      {/* Thin parting blade — narrow across the part axis */}
      <mesh position={[0, 11, 0]}>
        <boxGeometry args={[w, 22, 10]} />
        <meshStandardMaterial {...HSS} />
      </mesh>
      {/* Carbide tip at the origin */}
      <mesh position={[0, 0.75, 0]}>
        <boxGeometry args={[w + 0.4, 1.5, 3]} />
        <meshStandardMaterial {...CARBIDE} />
      </mesh>
    </group>
  );
}

/** Threading tool: block holder with a 60° V insert pointing at the work */
function ThreadingToolModel({ threadAngle = 60 }: { threadAngle?: number }) {
  const half = (threadAngle / 2) * (Math.PI / 180);
  const h = 6;
  return (
    <group>
      <mesh position={[0, 24, 0]}>
        <boxGeometry args={[14, 16, 14]} />
        <meshStandardMaterial {...HOLDER} />
      </mesh>
      <mesh position={[0, 11, 0]}>
        <boxGeometry args={[6, 12, 9]} />
        <meshStandardMaterial {...STEEL} />
      </mesh>
      {/* V-profile insert, apex at the origin (4-sided cone = pyramid) */}
      <mesh position={[0, h / 2, 0]} rotation={[Math.PI, 0, 0]}>
        <coneGeometry args={[h * Math.tan(half), h, 4]} />
        <meshStandardMaterial {...CARBIDE} />
      </mesh>
    </group>
  );
}

/** Twist drill: chuck, shank, fluted body, 118° point at the origin */
function DrillToolModel({ diameter = 10, pointAngle = 118 }: { diameter?: number; pointAngle?: number }) {
  const r = Math.max(diameter / 2, 1.5);
  const tipH = r / Math.tan((pointAngle / 2) * (Math.PI / 180));
  return (
    <group>
      {/* Chuck */}
      <mesh position={[0, tipH + 34, 0]}>
        <cylinderGeometry args={[r + 4, r + 5.5, 14, 24]} />
        <meshStandardMaterial {...HOLDER} />
      </mesh>
      {/* Fluted body — slightly stepped to suggest flutes */}
      <mesh position={[0, tipH + 14, 0]}>
        <cylinderGeometry args={[r, r, 28, 24]} />
        <meshStandardMaterial {...STEEL} />
      </mesh>
      {[0, 120, 240].map(a => (
        <mesh key={a} position={[0, tipH + 14, 0]} rotation={[0, (a * Math.PI) / 180, 0]}>
          <boxGeometry args={[r * 0.35, 28, r * 2.02]} />
          <meshStandardMaterial color="#5b626e" metalness={0.85} roughness={0.3} />
        </mesh>
      ))}
      {/* 118° point, apex at the origin */}
      <mesh position={[0, tipH / 2, 0]} rotation={[Math.PI, 0, 0]}>
        <coneGeometry args={[r, tipH, 24]} />
        <meshStandardMaterial {...HSS} />
      </mesh>
    </group>
  );
}

/** Router bit / end mill: collet nut, shank, fluted cutter, flat end at origin */
function EndMillModel({ diameter = 10 }: { diameter?: number }) {
  const r = Math.max(diameter / 2, 1.5);
  return (
    <group>
      {/* Collet nut */}
      <mesh position={[0, 36, 0]}>
        <cylinderGeometry args={[r + 3.5, r + 4.5, 10, 6]} />
        <meshStandardMaterial {...HOLDER} />
      </mesh>
      {/* Shank */}
      <mesh position={[0, 25, 0]}>
        <cylinderGeometry args={[r * 0.85, r * 0.85, 14, 20]} />
        <meshStandardMaterial {...STEEL} />
      </mesh>
      {/* Fluted cutting section down to the origin */}
      <mesh position={[0, 9, 0]}>
        <cylinderGeometry args={[r, r, 18, 20]} />
        <meshStandardMaterial color="#4a6f9e" metalness={0.85} roughness={0.25} />
      </mesh>
      {/* Flute grooves */}
      {[0, 90, 180, 270].map(a => (
        <mesh key={a} position={[0, 9, 0]} rotation={[0, (a * Math.PI) / 180, 0.35]}>
          <boxGeometry args={[r * 0.3, 18, r * 2.02]} />
          <meshStandardMaterial color="#334f73" metalness={0.85} roughness={0.3} />
        </mesh>
      ))}
    </group>
  );
}

/** Ball nose cutter: like an end mill but with a hemispherical tip */
function BallNoseModel({ diameter = 6 }: { diameter?: number }) {
  const r = Math.max(diameter / 2, 1.5);
  return (
    <group>
      <mesh position={[0, 34 + r, 0]}>
        <cylinderGeometry args={[r + 3.5, r + 4.5, 10, 6]} />
        <meshStandardMaterial {...HOLDER} />
      </mesh>
      <mesh position={[0, 22 + r, 0]}>
        <cylinderGeometry args={[r * 0.9, r * 0.9, 16, 20]} />
        <meshStandardMaterial {...STEEL} />
      </mesh>
      {/* Cutter body */}
      <mesh position={[0, 7 + r, 0]}>
        <cylinderGeometry args={[r, r, 14, 20]} />
        <meshStandardMaterial color="#4a6f9e" metalness={0.85} roughness={0.25} />
      </mesh>
      {/* Hemispherical tip touching the origin */}
      <mesh position={[0, r, 0]}>
        <sphereGeometry args={[r, 20, 16]} />
        <meshStandardMaterial color="#4a6f9e" metalness={0.85} roughness={0.25} />
      </mesh>
    </group>
  );
}

/** V-carving bit: shank with a conical point, apex at the origin */
function VBitModel({ angle = 60 }: { angle?: number }) {
  const half = (angle / 2) * (Math.PI / 180);
  const h = 10;
  const topR = h * Math.tan(half);
  return (
    <group>
      <mesh position={[0, h + 26, 0]}>
        <cylinderGeometry args={[topR + 2.5, topR + 3.5, 10, 6]} />
        <meshStandardMaterial {...HOLDER} />
      </mesh>
      <mesh position={[0, h + 12, 0]}>
        <cylinderGeometry args={[Math.max(topR * 0.7, 3), Math.max(topR * 0.7, 3), 18, 20]} />
        <meshStandardMaterial {...STEEL} />
      </mesh>
      {/* Conical cutting point */}
      <mesh position={[0, h / 2, 0]} rotation={[Math.PI, 0, 0]}>
        <coneGeometry args={[topR, h, 24]} />
        <meshStandardMaterial {...HSS} />
      </mesh>
    </group>
  );
}

/** Sanding paddle: arm with a flat abrasive pad, pad face at the origin */
function SandingToolModel({ width = 50 }: { width?: number }) {
  const w = Math.min(Math.max(width * 0.5, 15), 40);
  return (
    <group>
      {/* Mounting arm */}
      <mesh position={[0, 22, 0]}>
        <boxGeometry args={[8, 24, 8]} />
        <meshStandardMaterial {...HOLDER} />
      </mesh>
      {/* Pad backing plate */}
      <mesh position={[0, 6, 0]}>
        <boxGeometry args={[w, 4, 20]} />
        <meshStandardMaterial color="#2e343d" metalness={0.5} roughness={0.6} />
      </mesh>
      {/* Abrasive pad face */}
      <mesh position={[0, 2, 0]}>
        <boxGeometry args={[w, 4, 20]} />
        <meshStandardMaterial color="#c19a6b" roughness={1} metalness={0} />
      </mesh>
    </group>
  );
}

/** Planer head: horizontal cutter drum with straight knives, spinning above the part */
function PlanerToolModel({ width = 60 }: { width?: number }) {
  const drumR = 12;
  const len = Math.min(Math.max(width, 40), 90);
  return (
    <group>
      {/* Motor housing */}
      <mesh position={[0, drumR * 2 + 16, 0]}>
        <boxGeometry args={[len * 0.7, 18, 22]} />
        <meshStandardMaterial {...HOLDER} />
      </mesh>
      {/* Cutter drum — axis along the part (local X), knives at the bottom */}
      <mesh position={[0, drumR, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[drumR, drumR, len, 24]} />
        <meshStandardMaterial {...STEEL} />
      </mesh>
      {/* Straight knives along the drum */}
      {[0, 120, 240].map(a => {
        const rad = (a * Math.PI) / 180;
        return (
          <mesh key={a} position={[0, drumR + Math.sin(rad) * (drumR - 0.5), Math.cos(rad) * (drumR - 0.5)]} rotation={[rad, 0, 0]}>
            <boxGeometry args={[len - 4, 1, 4]} />
            <meshStandardMaterial {...CARBIDE} />
          </mesh>
        );
      })}
    </group>
  );
}

/** Tool types that mount radially (come at the part from the front like a
 * lathe cross-slide) vs spindle tools that hang above the part */
const RADIAL_TOOL_TYPES = new Set(['turning', 'grooving', 'parting', 'threading', 'drilling', 'boring', 'sanding']);

function ToolVisual({
  position,
  tool
}: {
  position: [number, number, number];
  tool?: Tool;
}) {
  const toolType = tool?.type || 'turning';
  const params = (tool?.params || {}) as Record<string, any>;
  const diameter = params.diameter || 10;

  const renderTool = () => {
    switch (toolType) {
      case 'turning':
        return <TurningToolModel noseAngle={params.noseAngle || 55} />;
      case 'drilling':
      case 'boring':
        return <DrillToolModel diameter={diameter} pointAngle={params.pointAngle || 118} />;
      case 'milling':
      case 'routing':
      case 'engraving':
        return <EndMillModel diameter={diameter} />;
      case 'ball_nose':
        return <BallNoseModel diameter={diameter} />;
      case 'v_bit':
        return <VBitModel angle={params.angle || 60} />;
      case 'sanding':
        return <SandingToolModel width={params.width || 50} />;
      case 'planing':
        return <PlanerToolModel width={params.width || 60} />;
      case 'grooving':
      case 'parting':
        return <GroovingToolModel cutWidth={params.cutWidth || 3} />;
      case 'threading':
        return <ThreadingToolModel threadAngle={params.threadAngle || 60} />;
      default:
        return <TurningToolModel />;
    }
  };

  // Radial tools: rotate the Y-up model so the shank points away from the
  // spindle axis (+Z in the scene, toward the viewer). Spindle tools keep
  // the shank pointing up. The tool does NOT rotate with the A-axis — on
  // this machine the workpiece spins, the tool stays put.
  const radial = RADIAL_TOOL_TYPES.has(toolType);

  return (
    <group position={position} rotation={radial ? [Math.PI / 2, 0, 0] : [0, 0, 0]}>
      {renderTool()}
    </group>
  );
}

// ============================================================
// MULTI-COLOR TOOLPATH
// ============================================================

function MultiColorToolpath({
  points,
  visibleCount,
}: {
  points: ToolpathPoint[];
  visibleCount: number;
}) {
  const segments = useMemo(() => {
    if (points.length < 2) return [];

    const visiblePoints = points.slice(0, Math.max(visibleCount, 1) + 1);
    if (visiblePoints.length < 2) return [];

    // Build segments: rapid moves in red, cutting moves in green (or op-colored)
    const result: { points: THREE.Vector3[]; color: string }[] = [];
    let currentSegment: THREE.Vector3[] = [];
    let currentColor = '#00ff00';

    for (let i = 0; i < visiblePoints.length; i++) {
      const p = visiblePoints[i];
      const [sx, sy, sz] = toSceneWithRotation(p.x, p.y, p.z, p.a || 0);
      const vec = new THREE.Vector3(sx, sy, sz);

      const isRapid = p.moveType === 'rapid';
      const color = isRapid ? '#ff0000' : '#00ff00';

      if (color !== currentColor && currentSegment.length > 0) {
        // Push current segment + start next one from last point
        if (currentSegment.length >= 2) {
          result.push({ points: [...currentSegment], color: currentColor });
        }
        currentSegment = [currentSegment[currentSegment.length - 1]];
        currentColor = color;
      }

      currentSegment.push(vec);
    }

    if (currentSegment.length >= 2) {
      result.push({ points: currentSegment, color: currentColor });
    }

    return result;
  }, [points, visibleCount]);

  return (
    <>
      {segments.map((seg, i) => (
        <Line
          key={i}
          points={seg.points}
          color={seg.color}
          lineWidth={seg.color === '#ff0000' ? 1 : 2}
          dashed={seg.color === '#ff0000'}
          dashSize={3}
          gapSize={2}
        />
      ))}
    </>
  );
}

// ============================================================
// AXIS LABELS
// ============================================================

function AxisLabels({ stockLength, stockDiameter }: { stockLength: number; stockDiameter: number }) {
  const axisLength = Math.max(stockLength, stockDiameter) * 0.3;
  const labelOffset = axisLength + 10;

  return (
    <group position={[-30, -stockDiameter * 0.8, -stockDiameter * 0.8]}>
      {/* Z axis (machine) = X in scene - along workpiece */}
      <Line points={[[0, 0, 0], [axisLength, 0, 0]]} color="#ff4444" lineWidth={2} />
      <Text position={[labelOffset, 0, 0]} fontSize={8} color="#ff4444" anchorX="center">Z</Text>

      {/* Y axis (machine) = Y in scene - vertical */}
      <Line points={[[0, 0, 0], [0, axisLength, 0]]} color="#44ff44" lineWidth={2} />
      <Text position={[0, labelOffset, 0]} fontSize={8} color="#44ff44" anchorX="center">Y</Text>

      {/* X axis (machine) = Z in scene - radial */}
      <Line points={[[0, 0, 0], [0, 0, axisLength]]} color="#4444ff" lineWidth={2} />
      <Text position={[0, 0, labelOffset]} fontSize={8} color="#4444ff" anchorX="center">X</Text>
    </group>
  );
}

// ============================================================
// MACHINE ELEMENTS
// ============================================================

function Headstock() {
  return (
    <group position={[-20, 0, 0]}>
      <mesh>
        <boxGeometry args={[40, 80, 80]} />
        <meshStandardMaterial color="#333333" metalness={0.7} roughness={0.4} />
      </mesh>
      <mesh position={[25, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[15, 20, 10, 32]} />
        <meshStandardMaterial color="#555555" metalness={0.8} roughness={0.3} />
      </mesh>
    </group>
  );
}

function Tailstock({ stockLength }: { stockLength: number }) {
  return (
    <group position={[stockLength + 30, 0, 0]}>
      <mesh>
        <boxGeometry args={[30, 60, 60]} />
        <meshStandardMaterial color="#333333" metalness={0.7} roughness={0.4} />
      </mesh>
      <mesh position={[-20, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
        <coneGeometry args={[10, 20, 32]} />
        <meshStandardMaterial color="#555555" metalness={0.8} roughness={0.3} />
      </mesh>
    </group>
  );
}

// ============================================================
// SIMULATION CONTROLLER
// ============================================================

function SimulationController({
  isSimulating,
  toolpath,
  progress,
  onProgressChange,
  onComplete,
}: {
  isSimulating: boolean;
  toolpath: ToolpathPoint[];
  progress: number;
  onProgressChange: (p: number) => void;
  onComplete?: () => void;
}) {
  // Calculate total toolpath distance for timing-based simulation
  const totalDistance = useMemo(() => {
    let dist = 0;
    for (let i = 1; i < toolpath.length; i++) {
      const dx = toolpath[i].x - toolpath[i - 1].x;
      const dy = toolpath[i].y - toolpath[i - 1].y;
      const dz = toolpath[i].z - toolpath[i - 1].z;
      dist += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    return Math.max(dist, 1);
  }, [toolpath]);

  useFrame((_, delta) => {
    if (isSimulating && progress < 1) {
      // Speed: traverse ~200mm/s of toolpath (scaled for visualization)
      const speed = 200;
      const increment = (speed * delta) / totalDistance;
      const newProgress = Math.min(progress + increment, 1);
      onProgressChange(newProgress);
      if (newProgress >= 1 && onComplete) {
        onComplete();
      }
    }
  });

  return null;
}

// ============================================================
// IMPORTED MESH
// ============================================================

function ImportedMesh({
  geometry: importedGeometry,
  stockLength
}: {
  geometry: ImportedGeometry;
  stockLength: number;
}) {
  const meshGeometry = useMemo(() => {
    if (!importedGeometry.meshData?.vertices) return null;

    const geometry = new THREE.BufferGeometry();
    const vertices = new Float32Array(importedGeometry.meshData.vertices);
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));

    if (importedGeometry.meshData.normals) {
      const normals = new Float32Array(importedGeometry.meshData.normals);
      geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    } else {
      geometry.computeVertexNormals();
    }

    if (importedGeometry.meshData.indices) {
      const indices = new Uint32Array(importedGeometry.meshData.indices);
      geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    }

    // Apply the same machine → scene axis remap used for the stock and
    // toolpath (sceneX = -machineZ, sceneY = machineY, sceneZ = machineX).
    // Without this the part renders 90° off-axis against its own stock.
    const remap = new THREE.Matrix4().set(
      0, 0, -1, 0,
      0, 1, 0, 0,
      1, 0, 0, 0,
      0, 0, 0, 1
    );
    geometry.applyMatrix4(remap);

    geometry.computeBoundingBox();
    const bbox = geometry.boundingBox;
    if (bbox) {
      // Center the part on the spindle axis and align it with the stock,
      // which spans scene X 0..stockLength
      const centerX = (bbox.max.x + bbox.min.x) / 2;
      const centerY = (bbox.max.y + bbox.min.y) / 2;
      const centerZ = (bbox.max.z + bbox.min.z) / 2;
      geometry.translate(-centerX + stockLength / 2, -centerY, -centerZ);
    }
    geometry.computeVertexNormals();

    return geometry;
  }, [importedGeometry, stockLength]);

  // Dispose on unmount
  useEffect(() => {
    return () => { meshGeometry?.dispose(); };
  }, [meshGeometry]);

  if (!meshGeometry) return null;

  return (
    <mesh geometry={meshGeometry}>
      <meshStandardMaterial
        color="#4a90d9"
        transparent
        opacity={0.7}
        roughness={0.4}
        metalness={0.3}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

// ============================================================
// MAIN CANVAS
// ============================================================

export function ThreeCanvas({
  stock,
  toolpath,
  currentTool,
  isSimulating,
  simulationProgress,
  onSimulationComplete,
  onProgressUpdate,
  className,
  importedGeometry,
  operations,
}: ThreeCanvasProps) {
  const [internalProgress, setInternalProgress] = useState(simulationProgress);

  // Re-sync from the parent whenever a simulation starts — otherwise
  // internalProgress is stuck at 1 after a completed run and the `progress
  // < 1` guard blocks every replay
  useEffect(() => {
    if (isSimulating) setInternalProgress(simulationProgress);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSimulating]);

  const progress = isSimulating ? internalProgress : simulationProgress;

  // Distance-based interpolation: constant tool speed along the path,
  // and the reveal index matches how SimulationController advances progress
  const cumDist = useMemo(() => cumulativeDistances(toolpath), [toolpath]);

  const { currentPoint, visibleCount } = useMemo(() => {
    if (toolpath.length === 0) {
      return { currentPoint: { x: stock.diameter + 20, y: 0, z: 0, a: 0 }, visibleCount: 0 };
    }
    const { point, index } = interpolateAlongPath(toolpath, cumDist, progress);
    return { currentPoint: point, visibleCount: index };
  }, [toolpath, cumDist, progress, stock.diameter]);

  // Report live progress to the parent (throttled to whole percent) so the
  // editor's progress slider tracks the simulation instead of sitting at 0
  const lastReportedRef = useRef(-1);
  const handleInternalProgress = (p: number) => {
    setInternalProgress(p);
    const pct = Math.floor(p * 100);
    if (onProgressUpdate && pct !== lastReportedRef.current) {
      lastReportedRef.current = pct;
      onProgressUpdate(p);
    }
  };

  // The tool sits at a fixed angular station — the WORKPIECE rotates, the
  // tool does not orbit it. Tip exactly at the programmed contact point.
  const toolPosition = toScene(
    currentPoint.x,
    currentPoint.y,
    currentPoint.z
  );

  // Turning paths carry no A data (the spindle just spins) — give the
  // workpiece a cosmetic spin while simulating. Paths that position the
  // A-axis (carving, indexing, engraving) drive the rotation directly.
  const hasAAxisMoves = useMemo(
    () => toolpath.some(p => Math.abs(p.a || 0) > 0.01),
    [toolpath]
  );

  return (
    <div className={className}>
      <Canvas shadows>
        <PerspectiveCamera
          makeDefault
          position={[stock.length * 0.6, stock.diameter * 3, stock.diameter * 3]}
          fov={50}
        />

        <ambientLight intensity={0.4} />
        <directionalLight
          position={[100, 100, 50]}
          intensity={1}
          castShadow
          shadow-mapSize={[2048, 2048]}
        />
        <pointLight position={[-50, 50, 50]} intensity={0.5} />

        <Stock
          stockType={stock.type || 'round'}
          diameter={stock.diameter}
          width={stock.width}
          height={stock.height}
          length={stock.length}
        />

        {importedGeometry?.meshData && (
          <ImportedMesh geometry={importedGeometry} stockLength={stock.length} />
        )}

        {toolpath.length > 0 && (
          <>
            {/* Turned result — shown for square stock too, since turning a
                square blank round is a normal job on this machine */}
            <Workpiece
              toolpath={toolpath}
              visibleCount={visibleCount}
              stockDiameter={stock.diameter}
              stockLength={stock.length}
              currentRotation={currentPoint.a || 0}
              spinning={isSimulating && !hasAAxisMoves}
            />
            <MultiColorToolpath
              points={toolpath}
              visibleCount={visibleCount}
            />
          </>
        )}

        <ToolVisual
          position={toolPosition}
          tool={currentTool}
        />

        <Headstock />
        <Tailstock stockLength={stock.length} />

        <AxisLabels stockLength={stock.length} stockDiameter={stock.diameter} />

        <Grid
          position={[stock.length / 2, -stock.diameter, 0]}
          args={[500, 500]}
          cellSize={10}
          cellThickness={0.5}
          cellColor="#333333"
          sectionSize={50}
          sectionThickness={1}
          sectionColor="#555555"
          fadeDistance={500}
        />

        <OrbitControls
          target={[stock.length / 2, 0, 0]}
          minDistance={50}
          maxDistance={2000}
        />

        <SimulationController
          isSimulating={isSimulating}
          toolpath={toolpath}
          progress={internalProgress}
          onProgressChange={handleInternalProgress}
          onComplete={() => {
            onProgressUpdate?.(1);
            onSimulationComplete?.();
          }}
        />
      </Canvas>
    </div>
  );
}
