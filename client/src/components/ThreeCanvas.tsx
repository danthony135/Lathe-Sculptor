import { useRef, useState, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Grid, PerspectiveCamera, Line } from '@react-three/drei';
import * as THREE from 'three';
import type { MachineStock, ToolpathPoint, Tool, ImportedGeometry } from '@shared/schema';

interface ThreeCanvasProps {
  stock: MachineStock;
  toolpath: ToolpathPoint[];
  currentTool?: Tool;
  isSimulating: boolean;
  simulationProgress: number;
  onSimulationComplete?: () => void;
  className?: string;
  importedGeometry?: ImportedGeometry;
}

// Convert machine coordinates to scene coordinates
// Machine: Z0 at headstock, negative Z toward tailstock, X/Y are radial
// Scene: X is length axis (0 at headstock, positive toward tailstock), Y is up, Z is depth
function toScene(machineX: number, machineY: number, machineZ: number): [number, number, number] {
  return [
    -machineZ,  // Machine Z (negative toward tailstock) → Scene X (positive toward tailstock)
    machineY,   // Machine Y (radial) → Scene Y (up)
    machineX,   // Machine X (radial) → Scene Z (depth)
  ];
}

// Convert machine coordinates to scene coordinates WITH A-axis rotation
// For indexed milling, the A-axis rotates the workpiece, so the tool's position
// in the X/Y plane (radial) rotates around the workpiece axis (scene X)
function toSceneWithRotation(machineX: number, machineY: number, machineZ: number, machineA: number): [number, number, number] {
  // Convert A-axis angle to radians
  const angleRad = (machineA * Math.PI) / 180;
  
  // Rotate the radial coordinates (X/Y) around the workpiece axis based on A-axis
  // When A=0°: X points toward scene +Z, Y points toward scene +Y
  // When A=90°: X points toward scene +Y, Y points toward scene -Z
  // When A=180°: X points toward scene -Z, Y points toward scene -Y
  // When A=270°: X points toward scene -Y, Y points toward scene +Z
  const rotatedY = machineX * Math.sin(angleRad) + machineY * Math.cos(angleRad);
  const rotatedZ = machineX * Math.cos(angleRad) - machineY * Math.sin(angleRad);
  
  return [
    -machineZ,  // Machine Z (negative toward tailstock) → Scene X (positive toward tailstock)
    rotatedY,   // Rotated Y position
    rotatedZ,   // Rotated Z position (was machine X)
  ];
}

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
  const meshRef = useRef<THREE.Mesh>(null);
  
  // For square stock, use width/height or default to diameter
  const stockWidth = width || diameter;
  const stockHeight = height || diameter;
  
  if (stockType === 'square') {
    // Square/rectangular stock (box geometry)
    return (
      <mesh ref={meshRef} position={[length / 2, 0, 0]}>
        <boxGeometry args={[length, stockHeight, stockWidth]} />
        <meshStandardMaterial 
          color="#D2691E" 
          transparent 
          opacity={0.3} 
          roughness={0.8}
        />
      </mesh>
    );
  }
  
  // Round stock (cylinder geometry)
  return (
    <mesh ref={meshRef} rotation={[0, 0, -Math.PI / 2]} position={[length / 2, 0, 0]}>
      <cylinderGeometry args={[diameter / 2, diameter / 2, length, 64]} />
      <meshStandardMaterial 
        color="#D2691E" 
        transparent 
        opacity={0.3} 
        roughness={0.8}
      />
    </mesh>
  );
}

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
    
    // Build profile from toolpath points
    // Use -Z for scene X position (0 to +length)
    // Clamp to stock length - don't render beyond the stock boundaries
    const profileMap = new Map<number, number>();
    
    for (const p of visiblePoints) {
      const sceneX = -p.z; // Convert machine Z to scene X
      
      // Skip points outside the stock boundaries (before headstock or past tailstock)
      if (sceneX < 0 || sceneX > stockLength) continue;
      
      const radius = Math.sqrt(p.x * p.x + p.y * p.y);
      const currentMin = profileMap.get(Math.round(sceneX)) ?? stockDiameter / 2;
      profileMap.set(Math.round(sceneX), Math.min(currentMin, radius));
    }
    
    // Sort by scene X position and create profile points
    const sortedPositions = Array.from(profileMap.entries()).sort((a, b) => a[0] - b[0]);
    
    if (sortedPositions.length < 2) return null;
    
    // Create Vector2 points for LatheGeometry (radius, axialPosition)
    const lathePoints = sortedPositions.map(([x, r]) => new THREE.Vector2(
      Math.max(r, 0.5), // Minimum radius to avoid degenerate geometry
      x
    ));
    
    // Add end caps if needed
    const firstX = sortedPositions[0][0];
    const lastX = sortedPositions[sortedPositions.length - 1][0];
    
    if (firstX > 5) {
      lathePoints.unshift(new THREE.Vector2(stockDiameter / 2, 0));
    }
    if (lastX < stockLength - 5) {
      lathePoints.push(new THREE.Vector2(stockDiameter / 2, stockLength));
    }
    
    const latheGeometry = new THREE.LatheGeometry(lathePoints, 64, 0, Math.PI * 2);
    
    // LatheGeometry creates geometry around Y axis with points at y positions 0 to stockLength
    // Rotate so the lathe axis aligns with scene X (the stock length direction)
    // Use -PI/2 to avoid mirroring the geometry about the headstock
    latheGeometry.rotateZ(-Math.PI / 2);
    
    // After rotation, geometry spans X: 0 to stockLength
    // Stock cylinder is at [length/2, 0, 0] with centered geometry, spanning X: 0 to length
    // No additional translation needed - geometry already starts at X=0
    
    return latheGeometry;
  }, [toolpath, progress, stockDiameter, stockLength]);

  if (!geometry) return null;

  // Position the turned profile at same location as stock (centered on length)
  return (
    <mesh ref={meshRef} geometry={geometry} position={[0, 0, 0]}>
      <meshStandardMaterial 
        color="#8B4513" 
        roughness={0.6}
        metalness={0.1}
      />
    </mesh>
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

  const toolDiameter = (tool?.params as Record<string, number>)?.diameter || 10;

  return (
    <group ref={toolRef} position={position}>
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <coneGeometry args={[toolDiameter / 2, toolDiameter * 2, 16]} />
        <meshStandardMaterial color="#4a90d9" metalness={0.8} roughness={0.2} />
      </mesh>
      <mesh position={[0, toolDiameter * 1.5, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[toolDiameter / 3, toolDiameter / 3, toolDiameter * 2, 16]} />
        <meshStandardMaterial color="#666666" metalness={0.9} roughness={0.3} />
      </mesh>
    </group>
  );
}

function Toolpath({ points, progress }: { points: ToolpathPoint[]; progress: number }) {
  const linePoints = useMemo(() => {
    if (points.length < 2) return null;
    
    const visiblePoints = points.slice(0, Math.floor(points.length * progress) + 1);
    if (visiblePoints.length < 2) return null;
    
    // Convert machine coords to scene coords WITH A-axis rotation
    // This correctly positions the toolpath for indexed milling operations
    return visiblePoints.map(p => {
      const [sx, sy, sz] = toSceneWithRotation(p.x, p.y, p.z, p.a || 0);
      return new THREE.Vector3(sx, sy, sz);
    });
  }, [points, progress]);

  if (!linePoints) return null;

  return (
    <Line points={linePoints} color="#00ff00" lineWidth={2} />
  );
}

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
    
    // Center and orient the mesh for lathe display
    // The mesh should be aligned with X axis (length direction)
    const bbox = geometry.boundingBox;
    if (bbox) {
      const centerX = (bbox.max.x + bbox.min.x) / 2;
      const centerY = (bbox.max.y + bbox.min.y) / 2;
      const centerZ = (bbox.max.z + bbox.min.z) / 2;
      
      // Translate to center at origin, then offset for stock position
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

export function ThreeCanvas({
  stock,
  toolpath,
  currentTool,
  isSimulating,
  simulationProgress,
  onSimulationComplete,
  className,
  importedGeometry,
}: ThreeCanvasProps) {
  const [internalProgress, setInternalProgress] = useState(simulationProgress);
  const progress = isSimulating ? internalProgress : simulationProgress;

  const currentPoint = useMemo(() => {
    if (toolpath.length === 0) return { x: stock.diameter + 20, y: 0, z: 0, a: 0 };
    const idx = Math.min(Math.floor(toolpath.length * progress), toolpath.length - 1);
    return toolpath[idx] || toolpath[0];
  }, [toolpath, progress, stock.diameter]);

  // Convert current tool position to scene coordinates WITH A-axis rotation
  // Add offset to position tool above the cutting point
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
            {/* Only show lathe workpiece for round stock (lathe turning) */}
            {stock.type === 'round' && (
              <Workpiece 
                toolpath={toolpath} 
                progress={progress}
                stockDiameter={stock.diameter}
                stockLength={stock.length}
                currentRotation={currentPoint.a}
              />
            )}
            <Toolpath points={toolpath} progress={progress} />
          </>
        )}
        
        <ToolVisual 
          position={toolPosition}
          rotation={currentPoint.a}
          tool={currentTool}
        />
        
        <Headstock />
        <Tailstock stockLength={stock.length} />
        
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
