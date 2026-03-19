/**
 * CAD File Converter Module
 * 
 * Handles conversion of DXF files containing 3DSOLID (ACIS) entities
 * to mesh formats (STL/OBJ) that can be processed by the lathe CAM system.
 * 
 * Strategy:
 * 1. Detect if DXF contains 3DSOLID entities
 * 2. Extract bounding box and attempt ACIS decode
 * 3. Generate approximate mesh from available data
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ConversionResult {
  success: boolean;
  outputPath?: string;
  outputData?: string;  // Base64 encoded STL/OBJ data
  format?: 'stl' | 'obj';
  message: string;
  warnings?: string[];
  boundingBox?: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  };
  dimensions?: {
    length: number;
    diameter: number;
  };
}

export interface DxfAnalysis {
  has3DSolid: boolean;
  entityTypes: string[];
  boundingBox?: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  };
  acisData?: string[];
}

/**
 * Analyze a DXF file to determine its contents
 */
export function analyzeDxfFile(dxfContent: string): DxfAnalysis {
  const lines = dxfContent.split(/\r?\n/).map(l => l.trim());
  const entityTypes = new Set<string>();
  const acisData: string[] = [];
  let has3DSolid = false;
  let inEntities = false;
  let in3DSolid = false;
  
  // Extract bounding box from header
  let extMin: { x: number; y: number; z: number } | null = null;
  let extMax: { x: number; y: number; z: number } | null = null;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Track section
    if (line === 'ENTITIES') inEntities = true;
    if (line === 'ENDSEC' && inEntities) inEntities = false;
    
    // Extract entity types
    if (inEntities && lines[i - 1] === '0') {
      entityTypes.add(line);
      if (line === '3DSOLID') {
        has3DSolid = true;
        in3DSolid = true;
      } else if (in3DSolid && line !== '1') {
        in3DSolid = false;
      }
    }
    
    // Collect ACIS data (group code 1)
    if (in3DSolid && lines[i - 1] === '1') {
      acisData.push(line);
    }
    
    // Extract bounding box from header
    if (line === '$EXTMIN') {
      extMin = { x: 0, y: 0, z: 0 };
      for (let j = i + 1; j < Math.min(i + 20, lines.length - 1); j += 2) {
        const code = parseInt(lines[j]);
        const value = parseFloat(lines[j + 1]);
        if (code === 10) extMin.x = value;
        else if (code === 20) extMin.y = value;
        else if (code === 30) extMin.z = value;
        else if (code === 9) break;
      }
    }
    if (line === '$EXTMAX') {
      extMax = { x: 0, y: 0, z: 0 };
      for (let j = i + 1; j < Math.min(i + 20, lines.length - 1); j += 2) {
        const code = parseInt(lines[j]);
        const value = parseFloat(lines[j + 1]);
        if (code === 10) extMax.x = value;
        else if (code === 20) extMax.y = value;
        else if (code === 30) extMax.z = value;
        else if (code === 9) break;
      }
    }
  }
  
  return {
    has3DSolid,
    entityTypes: Array.from(entityTypes),
    boundingBox: extMin && extMax ? { min: extMin, max: extMax } : undefined,
    acisData: acisData.length > 0 ? acisData : undefined,
  };
}

/**
 * Decode ACIS data from DXF
 * ACIS data in DXF is encoded using a simple character substitution cipher
 */
export function decodeAcisData(encodedLines: string[]): string {
  const decoded: string[] = [];
  
  for (const line of encodedLines) {
    let decodedLine = '';
    // Handle the special "^ " escape sequence (represents ^)
    const processedLine = line.replace(/\^ /g, '^');
    
    for (const char of processedLine) {
      const code = char.charCodeAt(0);
      // ACIS encoding: printable chars are transformed using 159 - code
      if (code >= 33 && code <= 126) {
        const decoded_code = 159 - code;
        if (decoded_code >= 32 && decoded_code <= 126) {
          decodedLine += String.fromCharCode(decoded_code);
        } else {
          decodedLine += char;
        }
      } else {
        decodedLine += char;
      }
    }
    decoded.push(decodedLine);
  }
  
  return decoded.join('\n');
}

/**
 * Parse decoded ACIS SAT data to extract geometry information
 */
export function parseAcisSat(satData: string): { 
  vertices: Array<{ x: number; y: number; z: number }>;
  hasSplines: boolean;
} {
  const vertices: Array<{ x: number; y: number; z: number }> = [];
  let hasSplines = false;
  
  const lines = satData.split('\n');
  
  for (const line of lines) {
    // Look for point/vertex definitions
    // SAT format has point entities like: point $1 -1 0 0 0 #
    const pointMatch = line.match(/point\s+\$?\d*\s+([-\d.e+]+)\s+([-\d.e+]+)\s+([-\d.e+]+)/i);
    if (pointMatch) {
      vertices.push({
        x: parseFloat(pointMatch[1]),
        y: parseFloat(pointMatch[2]),
        z: parseFloat(pointMatch[3]),
      });
    }
    
    // Look for straight-curve or line definitions with coordinates
    const straightMatch = line.match(/straight-curve[^#]*?([-\d.e+]+)\s+([-\d.e+]+)\s+([-\d.e+]+)/i);
    if (straightMatch) {
      vertices.push({
        x: parseFloat(straightMatch[1]),
        y: parseFloat(straightMatch[2]),
        z: parseFloat(straightMatch[3]),
      });
    }
    
    // Check for spline surfaces (indicates complex geometry)
    if (line.includes('spline') || line.includes('nurbs')) {
      hasSplines = true;
    }
  }
  
  return { vertices, hasSplines };
}

/**
 * Generate a simple STL mesh from bounding box for lathe profile approximation
 */
export function generateApproximateMesh(
  boundingBox: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } },
  resolution: number = 36
): string {
  const { min, max } = boundingBox;
  
  // Determine the axis orientation
  const xSpan = max.x - min.x;
  const ySpan = max.y - min.y;
  const zSpan = max.z - min.z;
  
  // For lathe parts, assume the longest axis is the length
  let length: number, radius: number;
  let lengthAxis: 'x' | 'y' | 'z';
  
  if (ySpan >= xSpan && ySpan >= zSpan) {
    lengthAxis = 'y';
    length = ySpan;
    radius = Math.max(xSpan, zSpan) / 2;
  } else if (xSpan >= ySpan && xSpan >= zSpan) {
    lengthAxis = 'x';
    length = xSpan;
    radius = Math.max(ySpan, zSpan) / 2;
  } else {
    lengthAxis = 'z';
    length = zSpan;
    radius = Math.max(xSpan, ySpan) / 2;
  }
  
  // Generate a simple cylinder mesh as approximation
  const triangles: string[] = [];
  const centerX = (min.x + max.x) / 2;
  const centerY = (min.y + max.y) / 2;
  const centerZ = (min.z + max.z) / 2;
  
  // Generate cylinder along the detected length axis
  for (let i = 0; i < resolution; i++) {
    const angle1 = (i / resolution) * Math.PI * 2;
    const angle2 = ((i + 1) / resolution) * Math.PI * 2;
    
    const cos1 = Math.cos(angle1);
    const sin1 = Math.sin(angle1);
    const cos2 = Math.cos(angle2);
    const sin2 = Math.sin(angle2);
    
    let v1: [number, number, number], v2: [number, number, number];
    let v3: [number, number, number], v4: [number, number, number];
    
    if (lengthAxis === 'y') {
      // Cylinder along Y axis
      v1 = [centerX + radius * cos1, min.y, centerZ + radius * sin1];
      v2 = [centerX + radius * cos2, min.y, centerZ + radius * sin2];
      v3 = [centerX + radius * cos1, max.y, centerZ + radius * sin1];
      v4 = [centerX + radius * cos2, max.y, centerZ + radius * sin2];
    } else if (lengthAxis === 'x') {
      // Cylinder along X axis
      v1 = [min.x, centerY + radius * cos1, centerZ + radius * sin1];
      v2 = [min.x, centerY + radius * cos2, centerZ + radius * sin2];
      v3 = [max.x, centerY + radius * cos1, centerZ + radius * sin1];
      v4 = [max.x, centerY + radius * cos2, centerZ + radius * sin2];
    } else {
      // Cylinder along Z axis
      v1 = [centerX + radius * cos1, centerY + radius * sin1, min.z];
      v2 = [centerX + radius * cos2, centerY + radius * sin2, min.z];
      v3 = [centerX + radius * cos1, centerY + radius * sin1, max.z];
      v4 = [centerX + radius * cos2, centerY + radius * sin2, max.z];
    }
    
    // Normal for triangle 1 (v1, v2, v4)
    const n1 = calculateNormal(v1, v2, v4);
    // Normal for triangle 2 (v1, v4, v3)
    const n2 = calculateNormal(v1, v4, v3);
    
    triangles.push(`  facet normal ${n1[0]} ${n1[1]} ${n1[2]}`);
    triangles.push(`    outer loop`);
    triangles.push(`      vertex ${v1[0]} ${v1[1]} ${v1[2]}`);
    triangles.push(`      vertex ${v2[0]} ${v2[1]} ${v2[2]}`);
    triangles.push(`      vertex ${v4[0]} ${v4[1]} ${v4[2]}`);
    triangles.push(`    endloop`);
    triangles.push(`  endfacet`);
    
    triangles.push(`  facet normal ${n2[0]} ${n2[1]} ${n2[2]}`);
    triangles.push(`    outer loop`);
    triangles.push(`      vertex ${v1[0]} ${v1[1]} ${v1[2]}`);
    triangles.push(`      vertex ${v4[0]} ${v4[1]} ${v4[2]}`);
    triangles.push(`      vertex ${v3[0]} ${v3[1]} ${v3[2]}`);
    triangles.push(`    endloop`);
    triangles.push(`  endfacet`);
  }
  
  // Add end caps
  const capCenter1: [number, number, number] = lengthAxis === 'y' 
    ? [centerX, min.y, centerZ]
    : lengthAxis === 'x' 
      ? [min.x, centerY, centerZ]
      : [centerX, centerY, min.z];
      
  const capCenter2: [number, number, number] = lengthAxis === 'y' 
    ? [centerX, max.y, centerZ]
    : lengthAxis === 'x' 
      ? [max.x, centerY, centerZ]
      : [centerX, centerY, max.z];
  
  for (let i = 0; i < resolution; i++) {
    const angle1 = (i / resolution) * Math.PI * 2;
    const angle2 = ((i + 1) / resolution) * Math.PI * 2;
    
    const cos1 = Math.cos(angle1);
    const sin1 = Math.sin(angle1);
    const cos2 = Math.cos(angle2);
    const sin2 = Math.sin(angle2);
    
    let v1: [number, number, number], v2: [number, number, number];
    let v3: [number, number, number], v4: [number, number, number];
    
    if (lengthAxis === 'y') {
      v1 = [centerX + radius * cos1, min.y, centerZ + radius * sin1];
      v2 = [centerX + radius * cos2, min.y, centerZ + radius * sin2];
      v3 = [centerX + radius * cos1, max.y, centerZ + radius * sin1];
      v4 = [centerX + radius * cos2, max.y, centerZ + radius * sin2];
    } else if (lengthAxis === 'x') {
      v1 = [min.x, centerY + radius * cos1, centerZ + radius * sin1];
      v2 = [min.x, centerY + radius * cos2, centerZ + radius * sin2];
      v3 = [max.x, centerY + radius * cos1, centerZ + radius * sin1];
      v4 = [max.x, centerY + radius * cos2, centerZ + radius * sin2];
    } else {
      v1 = [centerX + radius * cos1, centerY + radius * sin1, min.z];
      v2 = [centerX + radius * cos2, centerY + radius * sin2, min.z];
      v3 = [centerX + radius * cos1, centerY + radius * sin1, max.z];
      v4 = [centerX + radius * cos2, centerY + radius * sin2, max.z];
    }
    
    // Bottom cap
    const nBottom = lengthAxis === 'y' ? [0, -1, 0] : lengthAxis === 'x' ? [-1, 0, 0] : [0, 0, -1];
    triangles.push(`  facet normal ${nBottom[0]} ${nBottom[1]} ${nBottom[2]}`);
    triangles.push(`    outer loop`);
    triangles.push(`      vertex ${capCenter1[0]} ${capCenter1[1]} ${capCenter1[2]}`);
    triangles.push(`      vertex ${v2[0]} ${v2[1]} ${v2[2]}`);
    triangles.push(`      vertex ${v1[0]} ${v1[1]} ${v1[2]}`);
    triangles.push(`    endloop`);
    triangles.push(`  endfacet`);
    
    // Top cap
    const nTop = lengthAxis === 'y' ? [0, 1, 0] : lengthAxis === 'x' ? [1, 0, 0] : [0, 0, 1];
    triangles.push(`  facet normal ${nTop[0]} ${nTop[1]} ${nTop[2]}`);
    triangles.push(`    outer loop`);
    triangles.push(`      vertex ${capCenter2[0]} ${capCenter2[1]} ${capCenter2[2]}`);
    triangles.push(`      vertex ${v3[0]} ${v3[1]} ${v3[2]}`);
    triangles.push(`      vertex ${v4[0]} ${v4[1]} ${v4[2]}`);
    triangles.push(`    endloop`);
    triangles.push(`  endfacet`);
  }
  
  return `solid converted_from_dxf\n${triangles.join('\n')}\nendsolid converted_from_dxf`;
}

function calculateNormal(v1: [number, number, number], v2: [number, number, number], v3: [number, number, number]): [number, number, number] {
  const ux = v2[0] - v1[0];
  const uy = v2[1] - v1[1];
  const uz = v2[2] - v1[2];
  
  const vx = v3[0] - v1[0];
  const vy = v3[1] - v1[1];
  const vz = v3[2] - v1[2];
  
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len === 0) return [0, 0, 1];
  
  return [nx / len, ny / len, nz / len];
}

/**
 * Main conversion function
 * Attempts to convert a DXF with 3DSOLID to STL
 */
export async function convertDxfToStl(dxfContent: string, filename: string): Promise<ConversionResult> {
  const warnings: string[] = [];
  
  // Analyze the DXF file
  const analysis = analyzeDxfFile(dxfContent);
  
  if (!analysis.has3DSolid) {
    return {
      success: false,
      message: 'DXF file does not contain 3DSOLID entities. It may already have 2D profile data that can be imported directly.',
      warnings: [`Detected entity types: ${analysis.entityTypes.join(', ')}`],
    };
  }
  
  if (!analysis.boundingBox) {
    return {
      success: false,
      message: 'Could not extract bounding box from DXF header. The file may be corrupted or in an unsupported format.',
    };
  }
  
  // Calculate dimensions
  const { min, max } = analysis.boundingBox;
  const xSpan = max.x - min.x;
  const ySpan = max.y - min.y;
  const zSpan = max.z - min.z;
  
  // Determine orientation for lathe
  let length: number, diameter: number;
  if (ySpan >= xSpan && ySpan >= zSpan) {
    length = ySpan;
    diameter = Math.max(xSpan, zSpan);
  } else if (xSpan >= ySpan && xSpan >= zSpan) {
    length = xSpan;
    diameter = Math.max(ySpan, zSpan);
  } else {
    length = zSpan;
    diameter = Math.max(xSpan, ySpan);
  }
  
  warnings.push(`Detected dimensions: Length=${length.toFixed(1)}mm, Diameter=${diameter.toFixed(1)}mm`);
  
  // Try to decode ACIS data if available
  if (analysis.acisData && analysis.acisData.length > 0) {
    try {
      const decodedAcis = decodeAcisData(analysis.acisData);
      const parsedAcis = parseAcisSat(decodedAcis);
      
      if (parsedAcis.vertices.length > 0) {
        warnings.push(`Extracted ${parsedAcis.vertices.length} vertices from ACIS data`);
      }
      
      if (parsedAcis.hasSplines) {
        warnings.push('ACIS data contains spline/NURBS surfaces - approximation will be less accurate');
      }
    } catch (err) {
      warnings.push('Could not fully decode ACIS data - using bounding box approximation');
    }
  }
  
  // Generate approximate STL mesh
  const stlContent = generateApproximateMesh(analysis.boundingBox, 72);
  
  // Encode as base64 for transmission
  const base64Data = Buffer.from(stlContent).toString('base64');
  
  warnings.push('Generated cylindrical approximation from bounding box. For accurate profile, consider exporting as STL from your CAD software.');
  
  return {
    success: true,
    outputData: base64Data,
    format: 'stl',
    message: `Successfully converted ${filename} to STL (cylindrical approximation)`,
    warnings,
    boundingBox: analysis.boundingBox,
    dimensions: { length, diameter },
  };
}

/**
 * Try to use external converter if available (FreeCAD, etc.)
 */
export async function tryExternalConverter(inputPath: string, outputPath: string): Promise<ConversionResult | null> {
  // Try FreeCAD command line
  const freecadPaths = [
    process.env.FREECAD_PATH || '',
    '/usr/bin/freecadcmd',
    '/usr/bin/FreeCADCmd',
    '/usr/lib/freecad/bin/FreeCADCmd',
    '/Applications/FreeCAD.app/Contents/MacOS/FreeCADCmd',
    'C:\\Program Files\\FreeCAD 0.21\\bin\\FreeCADCmd.exe',
    'C:\\Program Files\\FreeCAD 0.20\\bin\\FreeCADCmd.exe',
  ].filter(Boolean);
  
  // Also check for our Python conversion script
  const scriptPath = path.join(__dirname, '..', 'scripts', 'freecad_convert.py');
  
  for (const fcPath of freecadPaths) {
    if (fs.existsSync(fcPath)) {
      try {
        // Create a Python script for conversion
        const script = `
import sys
sys.path.insert(0, '/usr/lib/freecad/lib')
sys.path.insert(0, '/usr/lib/freecad-python3/lib')

try:
    import FreeCAD
    import Part
    import Mesh
    import Import
except ImportError:
    print("FREECAD_IMPORT_ERROR")
    sys.exit(1)

try:
    # Open file
    Import.open("${inputPath.replace(/\\/g, '/')}")
    doc = FreeCAD.ActiveDocument
    
    if doc:
        objs = [o for o in doc.Objects if hasattr(o, 'Shape') and o.Shape]
        if objs:
            Mesh.export(objs, "${outputPath.replace(/\\/g, '/')}")
            print("SUCCESS:" + str(len(objs)))
        else:
            print("NO_SHAPES")
    else:
        print("NO_DOCUMENT")
except Exception as e:
    print("ERROR:" + str(e))
`;
        
        const tmpScript = path.join(os.tmpdir(), `fc_convert_${Date.now()}.py`);
        fs.writeFileSync(tmpScript, script);
        
        return new Promise((resolve) => {
          // Use xvfb-run for headless operation on Linux
          const useXvfb = process.platform === 'linux';
          const cmd = useXvfb ? 'xvfb-run' : fcPath;
          const args = useXvfb ? ['-a', fcPath, tmpScript] : [tmpScript];
          
          const proc = spawn(cmd, args, {
            timeout: 60000, // 60 second timeout
          });
          
          let stdout = '';
          let stderr = '';
          
          proc.stdout.on('data', (data) => { stdout += data.toString(); });
          proc.stderr.on('data', (data) => { stderr += data.toString(); });
          
          proc.on('close', (code) => {
            // Clean up temp script
            try { fs.unlinkSync(tmpScript); } catch {}
            
            if (stdout.includes('SUCCESS:') && fs.existsSync(outputPath)) {
              const match = stdout.match(/SUCCESS:(\d+)/);
              const objectCount = match ? parseInt(match[1]) : 1;
              
              const stlContent = fs.readFileSync(outputPath);
              resolve({
                success: true,
                outputPath,
                outputData: stlContent.toString('base64'),
                format: 'stl',
                message: `Successfully converted ${objectCount} object(s) using FreeCAD`,
                warnings: ['Converted using FreeCAD - actual geometry preserved'],
              });
            } else if (stdout.includes('NO_SHAPES')) {
              resolve({
                success: false,
                message: 'FreeCAD found no 3D shapes in the file',
              });
            } else if (stdout.includes('FREECAD_IMPORT_ERROR')) {
              // FreeCAD modules not available, fall back
              resolve(null);
            } else {
              // Some other error
              console.error('FreeCAD conversion failed:', stdout, stderr);
              resolve(null);
            }
          });
          
          proc.on('error', (err) => {
            console.error('FreeCAD spawn error:', err);
            resolve(null);
          });
        });
      } catch (err) {
        console.error('FreeCAD conversion error:', err);
        continue;
      }
    }
  }
  
  return null;
}

/**
 * Main conversion function - tries FreeCAD first, falls back to approximation
 */
export async function convertDxfToStlWithFreeCAD(
  dxfContent: string, 
  filename: string
): Promise<ConversionResult> {
  const warnings: string[] = [];
  
  // Write content to temp file
  const tmpDir = os.tmpdir();
  const inputPath = path.join(tmpDir, `input_${Date.now()}.dxf`);
  const outputPath = path.join(tmpDir, `output_${Date.now()}.stl`);
  
  try {
    fs.writeFileSync(inputPath, dxfContent);
    
    // Try FreeCAD conversion first
    const freecadResult = await tryExternalConverter(inputPath, outputPath);
    
    if (freecadResult?.success) {
      // Clean up temp files
      try { fs.unlinkSync(inputPath); } catch {}
      try { fs.unlinkSync(outputPath); } catch {}
      
      return freecadResult;
    }
    
    // Fall back to approximation method
    warnings.push('FreeCAD not available - using bounding box approximation');
    
  } catch (err) {
    warnings.push(`Temp file error: ${err}`);
  } finally {
    // Clean up
    try { fs.unlinkSync(inputPath); } catch {}
    try { fs.unlinkSync(outputPath); } catch {}
  }
  
  // Use the approximation method
  return convertDxfToStl(dxfContent, filename);
}
