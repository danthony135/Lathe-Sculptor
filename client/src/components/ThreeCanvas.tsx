import { useRef, useState, useMemo } from 'react';
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
  className?: string;
  importedGeometry?: ImportedGeometry;
  operations?: Operation[];
}

// Convert machine coordinates to scene coordinates
function toScene(machineX: number, machineY: number, machineZ: number): [number, number, number] {
  return [
    -machineZ,
    machineY,
    machineX,
  ];
}

// Convert with A-axis rotation
function toSceneWithRotation(machineX: number, machineY: number, machineZ: number, machineA: number): [number, number, number] {
  const angleRad = (machineA * Math.PI) / 180;
  const rotatedY = machineX * Math.sin(angleRad) + machineY * Math.cos(angleRad);
  const rotatedZ = machineX * Math.cos(angleRad) - machineY * Math.sin(angleRad);
  return [-machineZ, rotatedY, rotatedZ];
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
  progress,
  stockDiameter,
  stockLength,
  currentRotation
}: {
  toolpath: ToolpathPoint[];
  progress: number;
  stockDiameter: number;
  stockLength: number;
  currentRotation: number;
}) {
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame(() => {
    if (meshRef.current) {
      meshRef.current.rotation.x = (currentRotation * Math.PI) / 180;
    }
  });

  const geometry = useMemo(() => {
    if (toolpath.length < 2) return null;

    const visiblePoints = toolpath.slice(0, Math.floor(toolpath.length * progress) + 1);
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
  }, [toolpath, progress, stockDiameter, stockLength]);

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

const TOOL_COLORS = {
  body: '#4a90d9',
  shank: '#666666',
  insert: '#b8860b',
  sanding: '#c19a6b',
  drill: '#708090',
  vbit: '#b0c4de',
  ballnose: '#6495ed',
  planer: '#a0522d',
  threading: '#cd853f',
};

function TurningToolModel({ scale = 1 }: { scale?: number }) {
  return (
    <group scale={[scale, scale, scale]}>
      {/* Holder bar */}
      <mesh position={[0, 12, 0]}>
        <boxGeometry args={[6, 20, 6]} />
        <meshStandardMaterial color={TOOL_COLORS.shank} metalness={0.9} roughness={0.3} />
      </mesh>
      {/* Diamond insert */}
      <mesh position={[0, 0, 0]} rotation={[0, Math.PI / 4, 0]}>
        <boxGeometry args={[5, 2, 5]} />
        <meshStandardMaterial color={TOOL_COLORS.insert} metalness={0.7} roughness={0.2} />
      </mesh>
    </group>
  );
}

function DrillToolModel({ diameter = 10, scale = 1 }: { diameter?: number; scale?: number }) {
  const r = (diameter / 2) * scale;
  return (
    <group scale={[scale, scale, scale]}>
      {/* Shank */}
      <mesh position={[0, 20, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[r * 0.8, r * 0.8, 25, 16]} />
        <meshStandardMaterial color={TOOL_COLORS.shank} metalness={0.9} roughness={0.3} />
      </mesh>
      {/* Fluted body */}
      <mesh position={[0, 5, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[r * 0.3, r, 15, 16]} />
        <meshStandardMaterial color={TOOL_COLORS.drill} metalness={0.8} roughness={0.2} />
      </mesh>
      {/* Point */}
      <mesh position={[0, -3, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <coneGeometry args={[r * 0.3, 4, 16]} />
        <meshStandardMaterial color={TOOL_COLORS.drill} metalness={0.8} roughness={0.2} />
      </mesh>
    </group>
  );
}

function EndMillModel({ diameter = 10, scale = 1 }: { diameter?: number; scale?: number }) {
  const r = (diameter / 2) * scale;
  return (
    <group scale={[scale, scale, scale]}>
      {/* Shank */}
      <mesh position={[0, 22, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[r * 0.8, r * 0.8, 20, 16]} />
        <meshStandardMaterial color={TOOL_COLORS.shank} metalness={0.9} roughness={0.3} />
      </mesh>
      {/* Fluted cutting section */}
      <mesh position={[0, 8, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[r, r, 16, 16]} />
        <meshStandardMaterial color={TOOL_COLORS.body} metalness={0.8} roughness={0.2} />
      </mesh>
    </group>
  );
}

function BallNoseModel({ diameter = 6, scale = 1 }: { diameter?: number; scale?: number }) {
  const r = (diameter / 2) * scale;
  return (
    <group scale={[scale, scale, scale]}>
      {/* Shank */}
      <mesh position={[0, 22, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[r * 0.8, r * 0.8, 20, 16]} />
        <meshStandardMaterial color={TOOL_COLORS.shank} metalness={0.9} roughness={0.3} />
      </mesh>
      {/* Cylinder body */}
      <mesh position={[0, 8, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[r, r, 12, 16]} />
        <meshStandardMaterial color={TOOL_COLORS.ballnose} metalness={0.8} roughness={0.2} />
      </mesh>
      {/* Ball tip */}
      <mesh position={[0, 1, 0]}>
        <sphereGeometry args={[r, 16, 16, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial color={TOOL_COLORS.ballnose} metalness={0.8} roughness={0.2} />
      </mesh>
    </group>
  );
}

function VBitModel({ angle = 60, scale = 1 }: { angle?: number; scale?: number }) {
  const tipHalf = (angle / 2) * (Math.PI / 180);
  const topR = 5 * Math.tan(tipHalf) * scale;
  return (
    <group scale={[scale, scale, scale]}>
      {/* Shank */}
      <mesh position={[0, 22, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[4, 4, 20, 16]} />
        <meshStandardMaterial color={TOOL_COLORS.shank} metalness={0.9} roughness={0.3} />
      </mesh>
      {/* V-shaped tip */}
      <mesh position={[0, 5, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <coneGeometry args={[topR, 12, 16]} />
        <meshStandardMaterial color={TOOL_COLORS.vbit} metalness={0.8} roughness={0.2} />
      </mesh>
    </group>
  );
}

function SandingToolModel({ width = 50, scale = 1 }: { width?: number; scale?: number }) {
  return (
    <group scale={[scale, scale, scale]}>
      {/* Mounting arm */}
      <mesh position={[0, 20, 0]}>
        <boxGeometry args={[6, 15, 6]} />
        <meshStandardMaterial color={TOOL_COLORS.shank} metalness={0.8} roughness={0.3} />
      </mesh>
      {/* Sanding paddle */}
      <mesh position={[0, 5, 0]}>
        <boxGeometry args={[width * 0.3, 8, 15]} />
        <meshStandardMaterial color={TOOL_COLORS.sanding} roughness={0.9} metalness={0.1} />
      </mesh>
    </group>
  );
}

function PlanerToolModel({ scale = 1 }: { scale?: number }) {
  return (
    <group scale={[scale, scale, scale]}>
      {/* Spindle housing */}
      <mesh position={[0, 25, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[8, 8, 20, 16]} />
        <meshStandardMaterial color={TOOL_COLORS.shank} metalness={0.8} roughness={0.3} />
      </mesh>
      {/* Planer disc */}
      <mesh position={[0, 10, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[15, 15, 4, 32]} />
        <meshStandardMaterial color={TOOL_COLORS.planer} metalness={0.7} roughness={0.3} />
      </mesh>
      {/* Blade inserts */}
      {[0, 90, 180, 270].map((angle) => (
        <mesh key={angle} position={[Math.cos(angle * Math.PI / 180) * 13, 10, Math.sin(angle * Math.PI / 180) * 13]}>
          <boxGeometry args={[4, 2, 1]} />
          <meshStandardMaterial color={TOOL_COLORS.insert} metalness={0.9} roughness={0.1} />
        </mesh>
      ))}
    </group>
  );
}

function GroovingToolModel({ scale = 1 }: { scale?: number }) {
  return (
    <group scale={[scale, scale, scale]}>
      {/* Holder */}
      <mesh position={[0, 15, 0]}>
        <boxGeometry args={[6, 20, 6]} />
        <meshStandardMaterial color={TOOL_COLORS.shank} metalness={0.9} roughness={0.3} />
      </mesh>
      {/* Thin blade */}
      <mesh position={[0, 0, 0]}>
        <boxGeometry args={[1.5, 8, 8]} />
        <meshStandardMaterial color={TOOL_COLORS.insert} metalness={0.8} roughness={0.2} />
      </mesh>
    </group>
  );
}

function ThreadingToolModel({ scale = 1 }: { scale?: number }) {
  return (
    <group scale={[scale, scale, scale]}>
      {/* Holder */}
      <mesh position={[0, 15, 0]}>
        <boxGeometry args={[6, 20, 6]} />
        <meshStandardMaterial color={TOOL_COLORS.shank} metalness={0.9} roughness={0.3} />
      </mesh>
      {/* V-shaped threading insert */}
      <mesh position={[0, 0, 0]} rotation={[0, 0, Math.PI / 4]}>
        <boxGeometry args={[4, 2, 4]} />
        <meshStandardMaterial color={TOOL_COLORS.threading} metalness={0.8} roughness={0.2} />
      </mesh>
    </group>
  );
}

function ToolVisual({
  position,
  rotation,
  tool
}: {
  position: [number, number, number];
  rotation: number;
  tool?: Tool;
}) {
  const toolRef = useRef<THREE.Group>(null);

  useFrame(() => {
    if (toolRef.current) {
      toolRef.current.rotation.x = (rotation * Math.PI) / 180;
    }
  });

  const toolType = tool?.type || 'turning';
  const params = (tool?.params || {}) as Record<string, any>;
  const diameter = params.diameter || 10;

  const renderTool = () => {
    switch (toolType) {
      case 'turning':
        return <TurningToolModel />;
      case 'drilling':
        return <DrillToolModel diameter={diameter} />;
      case 'milling':
      case 'routing':
        return <EndMillModel diameter={diameter} />;
      case 'ball_nose':
        return <BallNoseModel diameter={diameter} />;
      case 'v_bit':
        return <VBitModel angle={params.angle || 60} />;
      case 'sanding':
        return <SandingToolModel width={params.width || 50} />;
      case 'planing':
        return <PlanerToolModel />;
      case 'grooving':
      case 'parting':
        return <GroovingToolModel />;
      case 'threading':
        return <ThreadingToolModel />;
      default:
        // Fallback: generic cone + cylinder
        return (
          <>
            <mesh rotation={[Math.PI / 2, 0, 0]}>
              <coneGeometry args={[diameter / 2, diameter * 2, 16]} />
              <meshStandardMaterial color={TOOL_COLORS.body} metalness={0.8} roughness={0.2} />
            </mesh>
            <mesh position={[0, diameter * 1.5, 0]} rotation={[Math.PI / 2, 0, 0]}>
              <cylinderGeometry args={[diameter / 3, diameter / 3, diameter * 2, 16]} />
              <meshStandardMaterial color={TOOL_COLORS.shank} metalness={0.9} roughness={0.3} />
            </mesh>
          </>
        );
    }
  };

  return (
    <group ref={toolRef} position={position}>
      {renderTool()}
    </group>
  );
}

// ============================================================
// MULTI-COLOR TOOLPATH
// ============================================================

// Color palette for operations
const OP_COLORS = [
  '#00ff00', // green - roughing
  '#ff6600', // orange - turning
  '#00ccff', // cyan - finishing
  '#ffcc00', // yellow - sanding
  '#ff00ff', // magenta - milling
  '#ff3333', // red - drilling
  '#33ff99', // mint - grooving
  '#9966ff', // purple - threading
  '#ff9999', // pink - planing
  '#66ffcc', // teal - engraving
  '#ccff33', // lime - 3D carving
  '#ff66cc', // hot pink - 4-axis
  '#3399ff', // blue - routing
];

function getToolpathColor(moveType?: string): string {
  if (moveType === 'rapid') return '#ff0000';
  return '#00ff00';
}

function MultiColorToolpath({
  points,
  progress,
  operations
}: {
  points: ToolpathPoint[];
  progress: number;
  operations?: Operation[];
}) {
  const segments = useMemo(() => {
    if (points.length < 2) return [];

    const visibleCount = Math.floor(points.length * progress) + 1;
    const visiblePoints = points.slice(0, visibleCount);
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
  }, [points, progress, operations]);

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
  useFrame((_, delta) => {
    if (isSimulating && progress < 1) {
      const newProgress = Math.min(progress + delta * 0.1, 1);
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

    geometry.computeBoundingBox();
    const bbox = geometry.boundingBox;
    if (bbox) {
      const centerX = (bbox.max.x + bbox.min.x) / 2;
      const centerY = (bbox.max.y + bbox.min.y) / 2;
      const centerZ = (bbox.max.z + bbox.min.z) / 2;
      geometry.translate(-centerX + stockLength / 2, -centerY, -centerZ);
    }

    return geometry;
  }, [importedGeometry, stockLength]);

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
  className,
  importedGeometry,
  operations,
}: ThreeCanvasProps) {
  const [internalProgress, setInternalProgress] = useState(simulationProgress);
  const progress = isSimulating ? internalProgress : simulationProgress;

  const currentPoint = useMemo(() => {
    if (toolpath.length === 0) return { x: stock.diameter + 20, y: 0, z: 0, a: 0 };
    const idx = Math.min(Math.floor(toolpath.length * progress), toolpath.length - 1);
    return toolpath[idx] || toolpath[0];
  }, [toolpath, progress, stock.diameter]);

  const toolPosition = toSceneWithRotation(
    currentPoint.x + 30,
    currentPoint.y,
    currentPoint.z,
    currentPoint.a || 0
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
          stockType={stock.type || 'square'}
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
            {stock.type === 'round' && (
              <Workpiece
                toolpath={toolpath}
                progress={progress}
                stockDiameter={stock.diameter}
                stockLength={stock.length}
                currentRotation={currentPoint.a}
              />
            )}
            <MultiColorToolpath
              points={toolpath}
              progress={progress}
              operations={operations}
            />
          </>
        )}

        <ToolVisual
          position={toolPosition}
          rotation={currentPoint.a}
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
          onProgressChange={setInternalProgress}
          onComplete={onSimulationComplete}
        />
      </Canvas>
    </div>
  );
}
