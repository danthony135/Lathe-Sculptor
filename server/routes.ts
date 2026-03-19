import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import { generateGCode, parseGCode } from "./gcode-generator";
import { analyzeDxfFile, convertDxfToStl, convertDxfToStlWithFreeCAD } from "./cad-converter";
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
    
    // Generate G-code using the Catek generator with project name
    const gcode = generateGCode(project.data as any, {
      projectName: project.name
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
          description: 'Primary turning tool for profile cuts'
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
          description: 'Secondary turning tool for detail work'
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
          description: 'Center drilling and boring'
        }
      },
      {
        toolNumber: 5,
        name: "Router Tool",
        type: "routing",
        params: { 
          diameter: 6, 
          fluteLength: 20,
          flutes: 2,
          description: 'Detail routing and engraving'
        }
      },
      {
        toolNumber: 6,
        name: "Large Milling Tool",
        type: "milling",
        params: { 
          diameter: 60, 
          fluteLength: 30,
          flutes: 4,
          description: 'Heavy stock removal milling'
        }
      },
      {
        toolNumber: 7,
        name: "Parting Tool",
        type: "parting",
        params: { 
          cutWidth: 3,
          description: 'Workpiece parting and grooving'
        }
      }
    ];

    for (const tool of defaultTools) {
      await storage.createTool(tool);
    }
  }
}
