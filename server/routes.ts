import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import { generateGCode, parseGCode } from "./gcode-generator";
import { analyzeDxfFile, convertDxfToStl, convertDxfToStlWithFreeCAD } from "./cad-converter";
import { textToToolpath } from "./engraving-engine";
import { analyzeGeometry } from "./geometry-analyzer";
import { extractTriangles, sampleSurface, generateFinishingToolpath, generateRoughingToolpath, generateSpiralFlutes, generateWrappedPattern, generateHelicalPath, convertToInverseTime } from "./toolpath-engine";
import type { MachineConfig, SpindleConfig, ToolpathPoint, Carving3DParams } from "@shared/schema";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // Health check for Railway
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Projects
  app.get(api.projects.list.path, async (req, res) => {
    const projects = await storage.getProjects();
    res.json(projects);
  });

  app.get(api.projects.get.path, async (req, res) => {
    const project = await storage.getProject(Number(req.params.id));
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }
    res.json(project);
  });

  app.post(api.projects.create.path, async (req, res) => {
    try {
      const input = api.projects.create.input.parse(req.body);
      const project = await storage.createProject(input);
      res.status(201).json(project);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: err.errors[0].message,
          field: err.errors[0].path.join('.'),
        });
      }
      throw err;
    }
  });

  app.put(api.projects.update.path, async (req, res) => {
    try {
      const input = api.projects.update.input.parse(req.body);
      const project = await storage.updateProject(Number(req.params.id), input);
      if (!project) return res.status(404).json({ message: 'Project not found' });
      res.json(project);
    } catch (err) {
       if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: err.errors[0].message,
          field: err.errors[0].path.join('.'),
        });
      }
      throw err;
    }
  });

  app.delete(api.projects.delete.path, async (req, res) => {
    await storage.deleteProject(Number(req.params.id));
    res.status(204).send();
  });

  app.post(api.projects.generateGCode.path, async (req, res) => {
    const project = await storage.getProject(Number(req.params.id));
    if (!project) return res.status(404).json({ message: 'Project not found' });

    // Load machine config from settings
    const machineConfigSetting = await storage.getSetting('machine_config');
    const machineConfig = machineConfigSetting?.value as MachineConfig | undefined;

    // Generate G-code using the Catek generator with project name
    const gcode = generateGCode(project.data as any, {
      projectName: project.name,
      machineConfig,
    });

    // Parse G-code back to toolpath for visualization
    const toolpath = parseGCode(gcode);

    // Update project data with the new toolpath from G-code
    const updatedData = {
      ...(project.data as any),
      toolpath: toolpath.length > 0 ? toolpath : (project.data as any).toolpath
    };

    // Save generated G-code and updated toolpath to project
    await storage.updateProject(project.id, {
      gcode,
      data: updatedData
    });

    res.json({ gcode });
  });

  // Parse G-code endpoint for simulation
  app.post('/api/gcode/parse', async (req, res) => {
    try {
      const { gcode } = req.body;
      if (!gcode || typeof gcode !== 'string') {
        return res.status(400).json({ message: 'G-code string required' });
      }
      const toolpath = parseGCode(gcode);
      res.json({ toolpath });
    } catch (err) {
      res.status(500).json({ message: 'Failed to parse G-code' });
    }
  });

  // Tools
  app.get(api.tools.list.path, async (req, res) => {
    const tools = await storage.getTools();
    res.json(tools);
  });

  app.post(api.tools.create.path, async (req, res) => {
    try {
      const input = api.tools.create.input.parse(req.body);
      const tool = await storage.createTool(input);
      res.status(201).json(tool);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: err.errors[0].message,
          field: err.errors[0].path.join('.'),
        });
      }
      throw err;
    }
  });

  app.put(api.tools.update.path, async (req, res) => {
    try {
      const input = api.tools.update.input.parse(req.body);
      const tool = await storage.updateTool(Number(req.params.id), input);
      if (!tool) return res.status(404).json({ message: 'Tool not found' });
      res.json(tool);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: err.errors[0].message,
          field: err.errors[0].path.join('.'),
        });
      }
      throw err;
    }
  });

  app.delete(api.tools.delete.path, async (req, res) => {
    await storage.deleteTool(Number(req.params.id));
    res.status(204).send();
  });

  // Settings
  app.get(api.settings.list.path, async (req, res) => {
    const allSettings = await storage.getAllSettings();
    res.json(allSettings);
  });

  app.get(api.settings.get.path, async (req, res) => {
    const setting = await storage.getSetting(req.params.key);
    if (!setting) {
      return res.status(404).json({ message: 'Setting not found' });
    }
    res.json(setting);
  });

  app.put(api.settings.upsert.path, async (req, res) => {
    const { value } = req.body;
    const setting = await storage.upsertSetting(req.params.key, value);
    res.json(setting);
  });

  app.delete(api.settings.delete.path, async (req, res) => {
    await storage.deleteSetting(req.params.key);
    res.status(204).send();
  });

  // ============================================================
  // TOOLPATH GENERATION ENDPOINTS
  // ============================================================

  // Geometry Analysis: auto-detect operations from imported geometry
  app.post('/api/analyze-geometry', async (req, res) => {
    try {
      const { geometry, material } = req.body;
      if (!geometry) return res.status(400).json({ message: 'Geometry data required' });
      const result = analyzeGeometry(geometry, material || 'oak');
      res.json(result);
    } catch (err: any) {
      console.error('Geometry analysis error:', err);
      res.status(500).json({ message: err.message || 'Failed to analyze geometry' });
    }
  });

  // Engraving: text → toolpath
  app.post('/api/toolpath/engrave', async (req, res) => {
    try {
      const { text, fontSize, engravingDepth, startZ, stockRadius, fontPath } = req.body;
      if (!text) return res.status(400).json({ message: 'Text is required' });

      const toolpath = await textToToolpath({
        text,
        fontSize: fontSize || 10,
        engravingDepth: engravingDepth || 1,
        startZ: startZ || -20,
        xOffset: stockRadius || 25,
        fontPath,
      });

      res.json({ toolpath, count: toolpath.length });
    } catch (err: any) {
      console.error('Engraving error:', err);
      res.status(500).json({ message: err.message || 'Failed to generate engraving toolpath' });
    }
  });

  // 3D Carving: mesh → toolpath (roughing + finishing)
  app.post('/api/toolpath/carve3d', async (req, res) => {
    try {
      const {
        vertices, normals, indices,
        toolRadius, scallopHeight, stepdown, strategy,
        stockRadius, stockLength, feedRate,
        finishAllowance, boundaryOffset,
        zResolution, angleResolution,
      } = req.body;

      if (!vertices || !vertices.length) {
        return res.status(400).json({ message: 'Mesh vertices required' });
      }

      // Extract triangles from mesh data
      const triangles = extractTriangles(vertices, normals, indices);

      // Sample the surface
      const samples = sampleSurface(triangles, {
        zResolution: zResolution || 2,
        angleResolution: angleResolution || 5,
        stockRadius: stockRadius || 50,
        stockLength: stockLength || 200,
      });

      // Generate roughing toolpath
      const roughingPath = generateRoughingToolpath(samples, {
        toolRadius: toolRadius || 3,
        stepdown: stepdown || 3,
        stockRadius: stockRadius || 50,
        stockLength: stockLength || 200,
        safeRadius: (stockRadius || 50) + 10,
        feedRate: feedRate || 300,
        finishAllowance: finishAllowance || 0.5,
      });

      // Generate finishing toolpath
      const finishingPath = generateFinishingToolpath(samples, {
        strategy: strategy || 'raster',
        toolRadius: toolRadius || 3,
        scallopHeight: scallopHeight || 0.1,
        stockRadius: stockRadius || 50,
        stockLength: stockLength || 200,
        safeRadius: (stockRadius || 50) + 10,
        feedRate: feedRate || 200,
        boundaryOffset: boundaryOffset || 2,
      });

      const toolpath = [...roughingPath, ...finishingPath];
      res.json({ toolpath, count: toolpath.length, roughingCount: roughingPath.length, finishingCount: finishingPath.length });
    } catch (err: any) {
      console.error('3D carving error:', err);
      res.status(500).json({ message: err.message || 'Failed to generate carving toolpath' });
    }
  });

  // 4-Axis Contouring: pattern → toolpath
  app.post('/api/toolpath/contour4axis', async (req, res) => {
    try {
      const { patternType, stockRadius, stockLength, toolRadius, feedRate } = req.body;

      let toolpath: ToolpathPoint[] = [];

      if (patternType === 'spiral_flute') {
        const { fluteCount, helixAngle, fluteDepth, depthPerPass } = req.body;
        toolpath = generateSpiralFlutes({
          stockRadius: stockRadius || 25,
          stockLength: stockLength || 200,
          fluteCount: fluteCount || 4,
          helixAngle: helixAngle || 45,
          fluteDepth: fluteDepth || 5,
          toolRadius: toolRadius || 3,
          feedRate: feedRate || 200,
          depthPerPass: depthPerPass || 2,
          startZ: 0,
          endZ: -(stockLength || 200),
          safeRadius: (stockRadius || 25) + 10,
        });
      } else if (patternType === 'helical') {
        const { pitch, depth, depthPerPass, direction } = req.body;
        toolpath = generateHelicalPath({
          stockRadius: stockRadius || 25,
          stockLength: stockLength || 200,
          pitch: pitch || 20,
          depth: depth || 3,
          toolRadius: toolRadius || 3,
          feedRate: feedRate || 200,
          depthPerPass: depthPerPass || 1,
          startZ: 0,
          endZ: -(stockLength || 200),
          direction: direction || 'right',
          safeRadius: (stockRadius || 25) + 10,
        });
      } else if (patternType === 'wrapped_pattern') {
        const { pattern, startAngle, endAngle, engravingDepth } = req.body;
        toolpath = generateWrappedPattern({
          stockRadius: stockRadius || 25,
          stockLength: stockLength || 200,
          toolRadius: toolRadius || 1,
          feedRate: feedRate || 300,
          engravingDepth: engravingDepth || 1,
          safeRadius: (stockRadius || 25) + 10,
          pattern: pattern || [],
          startAngle: startAngle || 0,
          endAngle: endAngle || 360,
          startZ: 0,
          endZ: -(stockLength || 200),
        });
      }

      // Convert to inverse time feed if requested
      if (req.body.useInverseTime) {
        toolpath = convertToInverseTime(toolpath, feedRate || 200, stockRadius || 25);
      }

      res.json({ toolpath, count: toolpath.length });
    } catch (err: any) {
      console.error('4-axis contouring error:', err);
      res.status(500).json({ message: err.message || 'Failed to generate 4-axis toolpath' });
    }
  });

  // CAD File Conversion API
  // Analyze a DXF file to determine if conversion is needed
  app.post('/api/cad/analyze', async (req, res) => {
    try {
      const { content, filename } = req.body;

      if (!content || typeof content !== 'string') {
        return res.status(400).json({ message: 'DXF content required' });
      }

      const analysis = analyzeDxfFile(content);

      res.json({
        filename: filename || 'unknown.dxf',
        has3DSolid: analysis.has3DSolid,
        entityTypes: analysis.entityTypes,
        boundingBox: analysis.boundingBox,
        needsConversion: analysis.has3DSolid,
        message: analysis.has3DSolid
          ? 'File contains 3DSOLID entities that need conversion to mesh format'
          : 'File contains standard 2D/3D entities that can be imported directly',
      });
    } catch (err) {
      console.error('DXF analysis error:', err);
      res.status(500).json({ message: 'Failed to analyze DXF file' });
    }
  });

  // Convert a DXF file with 3DSOLID to STL
  app.post('/api/cad/convert', async (req, res) => {
    try {
      const { content, filename } = req.body;

      if (!content || typeof content !== 'string') {
        return res.status(400).json({ message: 'DXF content required' });
      }

      // Use enhanced converter that tries FreeCAD first
      const result = await convertDxfToStlWithFreeCAD(content, filename || 'model.dxf');

      if (result.success) {
        res.json({
          success: true,
          stlData: result.outputData,  // Base64 encoded STL
          format: result.format,
          message: result.message,
          warnings: result.warnings,
          detectedUnits: result.detectedUnits,
          boundingBox: result.boundingBox,
          dimensions: result.dimensions,
        });
      } else {
        res.status(422).json({
          success: false,
          message: result.message,
          warnings: result.warnings,
        });
      }
    } catch (err) {
      console.error('DXF conversion error:', err);
      res.status(500).json({ message: 'Failed to convert DXF file' });
    }
  });

  // Seed Catek 7-in-1 default tools if empty
  await seedDefaultTools();

  // Seed default machine config if not set
  await seedDefaultMachineConfig();

  return httpServer;
}

async function seedDefaultTools() {
  const existingTools = await storage.getTools();
  if (existingTools.length === 0) {
    // Catek 7-in-1 Wood Lathe Tools
    const defaultTools = [
      {
        toolNumber: 1,
        name: "Turning Knife #1",
        type: "turning",
        params: {
          tipRadius: 0.4,
          noseAngle: 55,
          cutDirection: 'right',
          description: 'Primary turning tool for profile cuts',
          offsets: { offsetX: 0, offsetZ: 0, wearOffsetX: 0, wearOffsetZ: 0 }
        }
      },
      {
        toolNumber: 2,
        name: "Turning Knife #2",
        type: "turning",
        params: {
          tipRadius: 0.2,
          noseAngle: 35,
          cutDirection: 'left',
          description: 'Secondary turning tool for detail work',
          offsets: { offsetX: 0, offsetZ: 0, wearOffsetX: 0, wearOffsetZ: 0 }
        }
      },
      {
        toolNumber: 3,
        name: "Sanding Tool",
        type: "sanding",
        params: {
          diameter: 80,
          grit: 120,
          width: 50,
          description: 'Rotary sanding attachment for finishing'
        }
      },
      {
        toolNumber: 4,
        name: "Drill Tool",
        type: "drilling",
        params: {
          diameter: 10,
          pointAngle: 118,
          flutes: 2,
          description: 'Center drilling and boring',
          offsets: { offsetX: 0, offsetZ: 0, wearOffsetX: 0, wearOffsetZ: 0 }
        }
      },
      {
        toolNumber: 5,
        name: "Router / Engraving Tool",
        type: "routing",
        params: {
          diameter: 6,
          fluteLength: 20,
          flutes: 2,
          description: 'Detail routing and engraving',
          offsets: { offsetX: 0, offsetZ: 0, wearOffsetX: 0, wearOffsetZ: 0 }
        }
      },
      {
        toolNumber: 6,
        name: "Planer Blade",
        type: "planing",
        params: {
          width: 100,
          cutDepth: 3,
          description: 'Surface planing with 7.5kW planer spindle'
        }
      },
      {
        toolNumber: 7,
        name: "Parting / Grooving Tool",
        type: "grooving",
        params: {
          cutWidth: 3,
          maxDepth: 50,
          profile: 'square',
          description: 'Workpiece parting and grooving',
          offsets: { offsetX: 0, offsetZ: 0, wearOffsetX: 0, wearOffsetZ: 0 }
        }
      },
      {
        toolNumber: 8,
        name: "V-Bit 60°",
        type: "v_bit",
        params: {
          angle: 60,
          tipWidth: 0,
          maxDepth: 10,
          description: 'V-carving and engraving',
          offsets: { offsetX: 0, offsetZ: 0, wearOffsetX: 0, wearOffsetZ: 0 }
        }
      },
      {
        toolNumber: 9,
        name: "Ball Nose 6mm",
        type: "ball_nose",
        params: {
          diameter: 6,
          effectiveRadius: 3,
          neckDiameter: 6,
          fluteLength: 20,
          flutes: 2,
          description: '3D carving and surface finishing',
          offsets: { offsetX: 0, offsetZ: 0, wearOffsetX: 0, wearOffsetZ: 0 }
        }
      },
      {
        toolNumber: 10,
        name: "Threading Tool",
        type: "threading",
        params: {
          pitch: 2,
          threadAngle: 60,
          insertType: 'full',
          description: 'Wood threading insert',
          offsets: { offsetX: 0, offsetZ: 0, wearOffsetX: 0, wearOffsetZ: 0 }
        }
      }
    ];

    for (const tool of defaultTools) {
      await storage.createTool(tool);
    }
  }
}

async function seedDefaultMachineConfig() {
  const existing = await storage.getSetting('machine_config');
  if (!existing) {
    const defaultConfig: MachineConfig = {
      name: "Catek 7-in-1",
      model: "CK-1530-7T",
      maxDiameter: 300,
      maxLength: 1500,
      axes: 4,
      hasB_axis: false,
      spindles: [
        {
          id: 'main',
          name: 'Main Spindle (A-axis)',
          type: 'main',
          maxRPM: 6000,
          power: 4,
          mCodes: { start: 'M03', stop: 'M05', reverse: 'M04' }
        },
        {
          id: 'milling1',
          name: 'Milling Spindle #1',
          type: 'milling1',
          maxRPM: 18000,
          power: 6,
          mCodes: { start: 'M13', stop: 'M15' }
        },
        {
          id: 'milling2',
          name: 'Milling Spindle #2',
          type: 'milling2',
          maxRPM: 18000,
          power: 6,
          mCodes: { start: 'M23', stop: 'M25' }
        },
        {
          id: 'milling3',
          name: 'Milling Spindle #3',
          type: 'milling3',
          maxRPM: 18000,
          power: 6,
          mCodes: { start: 'M33', stop: 'M35' }
        },
        {
          id: 'planer',
          name: 'Planer Spindle',
          type: 'planer',
          maxRPM: 18000,
          power: 7.5,
          mCodes: { start: 'M43', stop: 'M45' }
        },
        {
          id: 'sanding',
          name: 'Sanding Motor',
          type: 'sanding',
          maxRPM: 6000,
          power: 1.1,
          mCodes: { start: 'M53', stop: 'M55' }
        }
      ],
      safeX: 100,
      safeY: 75,
      safeZ: 50,
      defaultRapidFeed: 5000,
      defaultWorkFeed: 200,
      defaultSpindleRPM: 2100,
      loaderCodes: {
        release: 'M69',
        start: 'M70',
        position: 'M71',
        complete: 'M72',
        clamp: 'M68',
      },
      auxCodes: {
        dustOn: 'M76',
        dustOff: 'M77',
      },
      postProcessor: {
        programEnd: 'M30',
        toolFormat: 'Ttttt',
        coordinateSystem: 'G55',
        units: 'metric',
        xAxisMode: 'diameter',
      },
    };
    await storage.upsertSetting('machine_config', defaultConfig);
  }
}
