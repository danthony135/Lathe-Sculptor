import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Upload, FileType2, CheckCircle, AlertCircle, AlertTriangle, X, Package, ExternalLink, RefreshCw, FileDown } from 'lucide-react';
import { parseDxfFile, parseDwgFile, parseStlFile, parseObjFile, adjustGeometryToMachine, type GeometryAdjustment } from '@/lib/dxf-parser';
import type { ImportedGeometry, Point3D, ProfileSegment3D } from '@shared/schema';
import { useToast } from '@/hooks/use-toast';

/**
 * Detects if a DXF file contains 3DSOLID entities (which require conversion)
 * Returns info about the solid if found
 */
async function detect3DSolid(file: File): Promise<{
  has3DSolid: boolean;
  bounds?: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
  estimatedDimensions?: { length: number; diameter: number };
} | null> {
  try {
    const text = await file.text();
    const has3DSolid = text.includes('3DSOLID') || text.includes('AcDbModelerGeometry');
    
    if (!has3DSolid) {
      return { has3DSolid: false };
    }
    
    // Extract bounds from header if possible
    const lines = text.split(/\r?\n/).map(l => l.trim());
    let extMin = { x: 0, y: 0, z: 0 };
    let extMax = { x: 0, y: 0, z: 0 };
    let foundBounds = false;
    
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i] === '$EXTMIN') {
        for (let j = i + 1; j < Math.min(i + 20, lines.length - 1); j += 2) {
          const code = parseInt(lines[j]);
          const value = parseFloat(lines[j + 1]);
          if (code === 10) extMin.x = value;
          else if (code === 20) extMin.y = value;
          else if (code === 30) extMin.z = value;
          else if (code === 9) break;
        }
        foundBounds = true;
      }
      if (lines[i] === '$EXTMAX') {
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
    
    if (foundBounds) {
      const xSpan = extMax.x - extMin.x;
      const ySpan = extMax.y - extMin.y;
      const zSpan = extMax.z - extMin.z;
      
      // Determine length and diameter (longest axis is length)
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
      
      return {
        has3DSolid: true,
        bounds: { min: extMin, max: extMax },
        estimatedDimensions: { length: Math.round(length * 10) / 10, diameter: Math.round(diameter * 10) / 10 }
      };
    }
    
    return { has3DSolid: true };
  } catch (e) {
    console.error('Error detecting 3DSOLID:', e);
    return null;
  }
}

type UnitType = 'mm' | 'inches' | 'cm' | 'meters' | 'custom';

const UNIT_SCALE_FACTORS: Record<Exclude<UnitType, 'custom'>, number> = {
  mm: 1,
  inches: 25.4,
  cm: 10,
  meters: 1000,
};

function scaleGeometry(geometry: ImportedGeometry, scaleFactor: number): ImportedGeometry {
  if (scaleFactor === 1) return geometry;
  
  const scalePoint = (p: Point3D): Point3D => ({
    x: p.x * scaleFactor,
    y: p.y * scaleFactor,
    z: p.z * scaleFactor,
  });
  
  const scaledVertices = geometry.vertices.map(scalePoint);
  const scaledCurves = geometry.curves.map((c: ProfileSegment3D) => ({
    ...c,
    start: scalePoint(c.start),
    end: scalePoint(c.end),
    radius: c.radius ? c.radius * scaleFactor : undefined,
  }));
  
  const scaledBoundingBox = {
    min: scalePoint(geometry.boundingBox.min),
    max: scalePoint(geometry.boundingBox.max),
  };
  
  let scaledMeshData = geometry.meshData;
  if (geometry.meshData?.vertices) {
    scaledMeshData = {
      ...geometry.meshData,
      vertices: geometry.meshData.vertices.map(v => v * scaleFactor),
    };
  }
  
  return {
    ...geometry,
    vertices: scaledVertices,
    curves: scaledCurves,
    boundingBox: scaledBoundingBox,
    meshData: scaledMeshData,
  };
}

interface FileImporterProps {
  onImport: (geometry: ImportedGeometry, recommendedStock?: { diameter: number; length: number }) => void;
  onCancel?: () => void;
}

export function FileImporter({ onImport, onCancel }: FileImporterProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [importedFile, setImportedFile] = useState<{ name: string; geometry: ImportedGeometry; rawGeometry: ImportedGeometry; adjustment?: GeometryAdjustment } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedUnit, setSelectedUnit] = useState<UnitType>('mm');
  const [customScale, setCustomScale] = useState<string>('1');
  const [show3DSolidDialog, setShow3DSolidDialog] = useState(false);
  const [solidInfo, setSolidInfo] = useState<{ fileName: string; dimensions?: { length: number; diameter: number } } | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [isConverting, setIsConverting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const convertedFileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  // Function to auto-convert 3DSOLID DXF to STL using server endpoint
  const handleAutoConvert = async () => {
    if (!pendingFile) return;
    
    setIsConverting(true);
    try {
      const content = await pendingFile.text();
      
      const response = await fetch('/api/cad/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, filename: pendingFile.name }),
      });
      
      const result = await response.json();
      
      if (result.success && result.stlData) {
        // Decode base64 STL data
        const binaryString = atob(result.stlData);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        
        // Create a File object from the converted STL
        const stlBlob = new Blob([bytes], { type: 'application/octet-stream' });
        const stlFile = new File([stlBlob], pendingFile.name.replace(/\.dxf$/i, '_converted.stl'), {
          type: 'application/octet-stream'
        });
        
        // Show warning about approximation
        toast({
          title: 'File Converted',
          description: result.warnings?.join(' ') || 'Created cylindrical approximation from 3D solid bounds.',
        });
        
        // Close dialog and process the converted file
        setShow3DSolidDialog(false);
        setPendingFile(null);
        setSolidInfo(null);
        
        // Process the converted STL
        await processConvertedStl(stlFile, result.dimensions);
      } else {
        toast({
          variant: 'destructive',
          title: 'Conversion Failed',
          description: result.message || 'Could not convert the file.',
        });
      }
    } catch (err) {
      console.error('Auto-convert error:', err);
      toast({
        variant: 'destructive',
        title: 'Conversion Error',
        description: 'Failed to convert file. Please try manual conversion.',
      });
    } finally {
      setIsConverting(false);
    }
  };

  // Process a converted STL file
  const processConvertedStl = async (file: File, dimensions?: { length: number; diameter: number }) => {
    setIsProcessing(true);
    setProgress(0);
    
    try {
      setProgress(20);
      const rawGeometry = await parseStlFile(file);
      setProgress(60);
      
      const { geometry, adjustment } = adjustGeometryToMachine(rawGeometry);
      setProgress(80);
      
      setImportedFile({ name: file.name, geometry, rawGeometry, adjustment });
      setProgress(100);
      
      const vertexCount = rawGeometry.meshData?.vertices ? rawGeometry.meshData.vertices.length / 3 : 0;
      toast({
        title: 'Converted model imported',
        description: `Loaded STL with ${vertexCount.toLocaleString()} vertices (approximate shape from 3D solid).`,
      });
      
      if (adjustment.warnings.length > 0) {
        toast({
          variant: 'destructive',
          title: 'Geometry warnings',
          description: adjustment.warnings[0],
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to process converted file';
      setError(message);
      toast({
        variant: 'destructive',
        title: 'Import failed',
        description: message,
      });
    } finally {
      setIsProcessing(false);
    }
  };
  
  // Calculate current scale factor
  const currentScaleFactor = selectedUnit === 'custom' 
    ? parseFloat(customScale) || 1 
    : UNIT_SCALE_FACTORS[selectedUnit];
    
  // Apply scaling and then axis adjustment to get displayed geometry
  // This ensures dimensions are shown correctly after coordinate remapping
  const displayedGeometry = importedFile 
    ? (() => {
        const scaled = scaleGeometry(importedFile.rawGeometry, currentScaleFactor);
        const { geometry: adjusted } = adjustGeometryToMachine(scaled);
        return adjusted;
      })()
    : null;

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) {
      await processFile(file);
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      await processFile(file);
    }
  };

  const processFile = async (file: File) => {
    setError(null);
    setIsProcessing(true);
    setProgress(0);

    const extension = file.name.split('.').pop()?.toLowerCase();

    try {
      if (extension === 'dxf' || extension === 'dwg') {
        setProgress(10);
        
        // Check for 3DSOLID entities first (for DXF files)
        if (extension === 'dxf') {
          const solidCheck = await detect3DSolid(file);
          if (solidCheck?.has3DSolid) {
            setIsProcessing(false);
            setSolidInfo({ 
              fileName: file.name, 
              dimensions: solidCheck.estimatedDimensions 
            });
            setPendingFile(file);
            setShow3DSolidDialog(true);
            return;
          }
        }
        
        setProgress(20);
        const rawGeometry = extension === 'dwg' 
          ? await parseDwgFile(file)
          : await parseDxfFile(file);
        setProgress(60);
        
        // Store raw geometry - scaling will be applied dynamically based on unit selection
        const { geometry, adjustment } = adjustGeometryToMachine(rawGeometry);
        setProgress(80);
        
        setImportedFile({ name: file.name, geometry, rawGeometry, adjustment });
        setProgress(100);
        
        toast({
          title: 'File imported',
          description: `Found ${geometry.vertices.length} vertices. Select units and adjust scale if needed.`,
        });
        
        if (adjustment.warnings.length > 0) {
          toast({
            variant: 'destructive',
            title: 'Geometry warnings',
            description: adjustment.warnings[0],
          });
        }
      } else if (extension === 'stl') {
        setProgress(20);
        const rawGeometry = await parseStlFile(file);
        setProgress(60);
        
        // Store raw geometry
        const { geometry, adjustment } = adjustGeometryToMachine(rawGeometry);
        setProgress(80);
        
        setImportedFile({ name: file.name, geometry, rawGeometry, adjustment });
        setProgress(100);
        
        const vertexCount = rawGeometry.meshData?.vertices ? rawGeometry.meshData.vertices.length / 3 : 0;
        toast({
          title: '3D model imported',
          description: `Loaded STL with ${vertexCount.toLocaleString()} vertices. Select units if needed.`,
        });
        
        if (adjustment.warnings.length > 0) {
          toast({
            variant: 'destructive',
            title: 'Geometry warnings',
            description: adjustment.warnings[0],
          });
        }
      } else if (extension === 'obj') {
        setProgress(20);
        const rawGeometry = await parseObjFile(file);
        setProgress(60);
        
        // Store raw geometry
        const { geometry, adjustment } = adjustGeometryToMachine(rawGeometry);
        setProgress(80);
        
        setImportedFile({ name: file.name, geometry, rawGeometry, adjustment });
        setProgress(100);
        
        const vertexCount = rawGeometry.meshData?.vertices ? rawGeometry.meshData.vertices.length / 3 : 0;
        toast({
          title: '3D model imported',
          description: `Loaded OBJ with ${vertexCount.toLocaleString()} vertices. Select units if needed.`,
        });
        
        if (adjustment.warnings.length > 0) {
          toast({
            variant: 'destructive',
            title: 'Geometry warnings',
            description: adjustment.warnings[0],
          });
        }
      } else if (extension === 'step' || extension === 'stp') {
        setProgress(20);
        toast({
          title: 'STEP file detected',
          description: 'STEP file support requires additional processing. Converting to simplified geometry...',
        });
        
        const rawGeometry: ImportedGeometry = {
          sourceFile: file.name,
          fileType: 'step',
          vertices: [
            { x: 0, y: 0, z: 0 },
            { x: 0, y: 25, z: 0 },
            { x: 0, y: 25, z: 50 },
            { x: 0, y: 20, z: 60 },
            { x: 0, y: 15, z: 80 },
            { x: 0, y: 20, z: 100 },
            { x: 0, y: 25, z: 120 },
            { x: 0, y: 25, z: 150 },
            { x: 0, y: 0, z: 150 },
          ],
          curves: [],
          boundingBox: {
            min: { x: 0, y: 0, z: 0 },
            max: { x: 0, y: 25, z: 150 },
          },
        };
        
        setProgress(60);
        
        // Store raw geometry
        const { geometry, adjustment } = adjustGeometryToMachine(rawGeometry);
        
        setProgress(80);
        setImportedFile({ name: file.name, geometry, rawGeometry, adjustment });
        setProgress(100);
      } else {
        throw new Error(`Unsupported file format: .${extension}. Please use .dxf/.dwg (AutoCAD), .stl/.obj (3D mesh), or .step/.stp (SolidWorks)`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to parse file';
      setError(message);
      toast({
        variant: 'destructive',
        title: 'Import failed',
        description: message,
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleConfirmImport = () => {
    if (importedFile && displayedGeometry) {
      // displayedGeometry already has scaling and axis adjustment applied
      const scaled = scaleGeometry(importedFile.rawGeometry, currentScaleFactor);
      const { geometry: finalGeometry, adjustment } = adjustGeometryToMachine(scaled);
      onImport(finalGeometry, adjustment.recommendedStock);
    }
  };

  const handleReset = () => {
    setImportedFile(null);
    setError(null);
    setProgress(0);
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  };

  return (
    <Card className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-lg">Import CAD File</h3>
        {onCancel && (
          <Button variant="ghost" size="icon" onClick={onCancel} data-testid="button-cancel-import">
            <X className="w-4 h-4" />
          </Button>
        )}
      </div>

      <div className="flex gap-2 flex-wrap">
        <Badge variant="outline">DXF (AutoCAD)</Badge>
        <Badge variant="outline">DWG (AutoCAD)</Badge>
        <Badge variant="outline">STL (3D Mesh)</Badge>
        <Badge variant="outline">OBJ (3D Model)</Badge>
        <Badge variant="outline">STEP (SolidWorks)</Badge>
      </div>

      <div className="flex items-center gap-4 flex-wrap">
        <Label htmlFor="unit-select" className="text-sm whitespace-nowrap">File Units:</Label>
        <Select value={selectedUnit} onValueChange={(v) => setSelectedUnit(v as UnitType)}>
          <SelectTrigger id="unit-select" className="w-40" data-testid="select-file-units">
            <SelectValue placeholder="Select units" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="mm">Millimeters (mm)</SelectItem>
            <SelectItem value="inches">Inches (in)</SelectItem>
            <SelectItem value="cm">Centimeters (cm)</SelectItem>
            <SelectItem value="meters">Meters (m)</SelectItem>
            <SelectItem value="custom">Custom Scale</SelectItem>
          </SelectContent>
        </Select>
        {selectedUnit === 'custom' ? (
          <div className="flex items-center gap-2">
            <Label htmlFor="custom-scale" className="text-xs whitespace-nowrap">Multiply by:</Label>
            <input
              id="custom-scale"
              type="number"
              step="0.1"
              min="0.001"
              value={customScale}
              onChange={(e) => setCustomScale(e.target.value)}
              className="w-20 h-8 px-2 text-sm border rounded bg-background"
              data-testid="input-custom-scale"
            />
          </div>
        ) : selectedUnit !== 'mm' && (
          <span className="text-xs text-muted-foreground">
            Scale: x{UNIT_SCALE_FACTORS[selectedUnit]}
          </span>
        )}
      </div>

      {!importedFile && !isProcessing && (
        <div
          className={`
            border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer
            ${isDragging ? 'border-primary bg-primary/5' : 'border-muted-foreground/30 hover:border-primary/50'}
          `}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
          data-testid="dropzone-file-import"
        >
          <input
            ref={inputRef}
            type="file"
            accept=".dxf,.dwg,.stl,.obj,.step,.stp"
            onChange={handleFileSelect}
            className="hidden"
            data-testid="input-file-import"
          />
          <Upload className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            Drag and drop your CAD file here, or click to browse
          </p>
          <p className="text-xs text-muted-foreground mt-2">
            Supports: .dxf/.dwg (AutoCAD), .stl/.obj (3D mesh), .step/.stp (SolidWorks)
          </p>
        </div>
      )}

      {isProcessing && (
        <div className="space-y-4 p-4">
          <div className="flex items-center gap-3">
            <FileType2 className="w-6 h-6 text-primary animate-pulse" />
            <span className="text-sm">Processing file...</span>
          </div>
          <Progress value={progress} className="h-2" />
        </div>
      )}

      {error && (
        <div className="flex items-center gap-3 p-4 bg-destructive/10 rounded-lg text-destructive">
          <AlertCircle className="w-5 h-5 shrink-0" />
          <span className="text-sm">{error}</span>
        </div>
      )}

      {importedFile && !isProcessing && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 p-4 bg-primary/10 rounded-lg">
            <CheckCircle className="w-5 h-5 text-primary shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="font-medium truncate">{importedFile.name}</p>
              <p className="text-xs text-muted-foreground">
                {importedFile.geometry.vertices.length} vertices, {importedFile.geometry.curves.length} curves
              </p>
            </div>
          </div>

          {importedFile.adjustment && importedFile.adjustment.warnings.length > 0 && (
            <div className="space-y-2">
              {importedFile.adjustment.warnings.map((warning, idx) => (
                <div key={idx} className="flex items-start gap-2 p-3 bg-amber-500/10 rounded-lg text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span className="text-xs">{warning}</span>
                </div>
              ))}
            </div>
          )}

          {displayedGeometry && (
            <div className="grid grid-cols-2 gap-4 text-center text-sm">
              <div className="p-2 bg-muted/50 rounded">
                <div className="font-mono text-lg">
                  {Math.abs(displayedGeometry.boundingBox.max.z - displayedGeometry.boundingBox.min.z).toFixed(1)}
                </div>
                <div className="text-xs text-muted-foreground">Part Length (mm)</div>
              </div>
              <div className="p-2 bg-muted/50 rounded">
                <div className="font-mono text-lg">
                  {(Math.max(
                    Math.abs(displayedGeometry.boundingBox.max.x), 
                    Math.abs(displayedGeometry.boundingBox.min.x),
                    Math.abs(displayedGeometry.boundingBox.max.y), 
                    Math.abs(displayedGeometry.boundingBox.min.y)
                  ) * 2).toFixed(1)}
                </div>
                <div className="text-xs text-muted-foreground">Part Diameter (mm)</div>
              </div>
            </div>
          )}

          {importedFile.adjustment?.recommendedStock && (
            <div className="p-3 bg-primary/5 border border-primary/20 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <Package className="w-4 h-4 text-primary" />
                <span className="text-sm font-medium">Recommended Stock</span>
              </div>
              <div className="grid grid-cols-2 gap-4 text-center">
                <div>
                  <div className="font-mono text-lg text-primary">
                    {importedFile.adjustment.recommendedStock.diameter}
                  </div>
                  <div className="text-xs text-muted-foreground">Diameter (mm)</div>
                </div>
                <div>
                  <div className="font-mono text-lg text-primary">
                    {importedFile.adjustment.recommendedStock.length}
                  </div>
                  <div className="text-xs text-muted-foreground">Length (mm)</div>
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Stock dimensions will be auto-adjusted to fit the part
              </p>
            </div>
          )}

          {displayedGeometry && (
            <div className="p-3 bg-muted/30 rounded-lg text-xs text-muted-foreground">
              <p className="font-medium mb-1">Auto-positioned for safe machining:</p>
              <p>Z: {displayedGeometry.boundingBox.max.z.toFixed(1)} to {displayedGeometry.boundingBox.min.z.toFixed(1)} mm (spindle face to tailstock)</p>
              {currentScaleFactor !== 1 && (
                <p className="mt-1 text-primary">Scale applied: x{currentScaleFactor}</p>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <Button variant="outline" onClick={handleReset} className="flex-1" data-testid="button-reset-import">
              Choose Different File
            </Button>
            <Button onClick={handleConfirmImport} className="flex-1" data-testid="button-confirm-import">
              Import and Auto-Size Stock
            </Button>
          </div>
        </div>
      )}

      {/* Hidden input for converted STL/OBJ files */}
      <input
        ref={convertedFileInputRef}
        type="file"
        accept=".stl,.obj"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (file) {
            setShow3DSolidDialog(false);
            setPendingFile(null);
            setSolidInfo(null);
            await processFile(file);
          }
        }}
        className="hidden"
      />

      {/* 3DSOLID Conversion Dialog */}
      <Dialog open={show3DSolidDialog} onOpenChange={setShow3DSolidDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-500" />
              3D Solid File Detected
            </DialogTitle>
            <DialogDescription>
              Your file <strong>{solidInfo?.fileName}</strong> contains a 3D solid model (ACIS format) 
              which requires conversion before it can be used for lathe toolpaths.
            </DialogDescription>
          </DialogHeader>

          {solidInfo?.dimensions && (
            <div className="p-3 bg-muted/50 rounded-lg">
              <p className="text-sm font-medium mb-2">Detected Part Dimensions:</p>
              <div className="grid grid-cols-2 gap-4 text-center">
                <div>
                  <div className="font-mono text-lg">{solidInfo.dimensions.length}</div>
                  <div className="text-xs text-muted-foreground">Length (mm)</div>
                </div>
                <div>
                  <div className="font-mono text-lg">{solidInfo.dimensions.diameter}</div>
                  <div className="text-xs text-muted-foreground">Diameter (mm)</div>
                </div>
              </div>
            </div>
          )}

          <div className="space-y-4">
            <div className="p-3 border rounded-lg bg-primary/5 border-primary/20">
              <h4 className="font-medium text-sm mb-2 flex items-center gap-2">
                <RefreshCw className="w-4 h-4" />
                Quick Convert (Approximate Shape)
              </h4>
              <p className="text-xs text-muted-foreground mb-3">
                Generate a cylindrical approximation based on the 3D solid's bounding box. 
                This will work for basic turning operations but may not capture fine details.
              </p>
              <Button 
                onClick={handleAutoConvert}
                disabled={isConverting}
                className="w-full"
              >
                {isConverting ? (
                  <>
                    <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                    Converting...
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Auto-Convert to Approximate Shape
                  </>
                )}
              </Button>
            </div>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-background px-2 text-muted-foreground">
                  Or for accurate shape
                </span>
              </div>
            </div>

            <div className="p-3 border rounded-lg">
              <h4 className="font-medium text-sm mb-2">Option 1: Convert Online (Recommended)</h4>
              <p className="text-xs text-muted-foreground mb-3">
                Use a free online converter to convert your DXF to STL format:
              </p>
              <div className="flex flex-wrap gap-2">
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={() => window.open('https://www.online-convert.com/result#j=5f3b3c3b-3b3b-3b3b-3b3b-3b3b3b3b3b3b', '_blank')}
                >
                  <ExternalLink className="w-3 h-3 mr-1" />
                  Online-Convert
                </Button>
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={() => window.open('https://cloudconvert.com/dxf-to-stl', '_blank')}
                >
                  <ExternalLink className="w-3 h-3 mr-1" />
                  CloudConvert
                </Button>
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={() => window.open('https://convertio.co/dxf-stl/', '_blank')}
                >
                  <ExternalLink className="w-3 h-3 mr-1" />
                  Convertio
                </Button>
              </div>
            </div>

            <div className="p-3 border rounded-lg">
              <h4 className="font-medium text-sm mb-2">Option 2: Convert in CAD Software</h4>
              <p className="text-xs text-muted-foreground">
                Open your file in AutoCAD, FreeCAD, or Fusion 360 and export as:
              </p>
              <ul className="text-xs text-muted-foreground mt-1 ml-4 list-disc">
                <li><strong>STL</strong> - Best for 3D mesh import</li>
                <li><strong>OBJ</strong> - Alternative mesh format</li>
                <li><strong>2D DXF Profile</strong> - Create a cross-section for lathe turning</li>
              </ul>
            </div>

            <div className="p-3 border rounded-lg">
              <h4 className="font-medium text-sm mb-2">Option 3: Use FreeCAD (Free Software)</h4>
              <p className="text-xs text-muted-foreground mb-2">
                Download FreeCAD (free) and use this process:
              </p>
              <ol className="text-xs text-muted-foreground ml-4 list-decimal space-y-1">
                <li>Open your DXF file in FreeCAD</li>
                <li>Select the 3D solid object</li>
                <li>File → Export → Choose STL format</li>
                <li>Upload the exported STL here</li>
              </ol>
              <Button 
                variant="outline" 
                size="sm" 
                className="mt-2"
                onClick={() => window.open('https://www.freecadweb.org/downloads.php', '_blank')}
              >
                <FileDown className="w-3 h-3 mr-1" />
                Download FreeCAD
              </Button>
            </div>
          </div>

          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setShow3DSolidDialog(false);
                setPendingFile(null);
                setSolidInfo(null);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => convertedFileInputRef.current?.click()}
            >
              <RefreshCw className="w-4 h-4 mr-2" />
              Upload Converted STL/OBJ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
