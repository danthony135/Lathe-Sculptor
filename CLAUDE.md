# Lathe-Sculptor

CAM (Computer-Aided Manufacturing) software for the Catek 7-in-1 CNC Wood Lathe.

## Project Overview

Lathe-Sculptor is a web-based application that processes CAD files (DXF, STL, OBJ, STEP) and generates G-code for CNC wood lathes. It's designed specifically for the Catek 7-in-1 lathe which has a 10-tool turret including turning knives, router, planer, carving tool, sander, and drilling capabilities.

## Tech Stack

- **Frontend**: React + TypeScript + Vite + Tailwind CSS + shadcn/ui
- **Backend**: Node.js + Express + TypeScript
- **Database**: PostgreSQL with Drizzle ORM
- **3D Visualization**: Three.js
- **CAD Parsing**: Custom DXF parser, STL/OBJ importers

## Project Structure

```
├── client/                 # React frontend
│   ├── src/
│   │   ├── components/    # UI components
│   │   ├── pages/         # Route pages
│   │   ├── hooks/         # Custom React hooks
│   │   └── lib/           # Utilities, parsers
├── server/                 # Express backend
│   ├── index.ts           # Entry point
│   ├── routes.ts          # API routes
│   ├── storage.ts         # Database operations
│   ├── gcode-generator.ts # G-code generation
│   └── cad-converter.ts   # CAD file conversion
├── shared/                 # Shared types/schemas
│   ├── schema.ts          # Drizzle database schema
│   └── routes.ts          # API route definitions
└── scripts/               # Build and seed scripts
```

## Key Features

1. **CAD File Import**: Supports DXF (including 3DSOLID), STL, OBJ formats
2. **3D Visualization**: Real-time preview of parts and toolpaths
3. **Tool Library**: Manage lathe tools with feeds, speeds, offsets
4. **G-code Generation**: Produces Fanuc-style G-code for Catek controller
5. **Project Management**: Save and organize machining projects

## Catek Machine Specifics

- **Coordinate System**: X = diameter (not radius), Z0 at spindle, negative Z toward tailstock
- **Tool Format**: Ttttt (5-digit tool numbers)
- **Max Tools**: 10-position turret
- **Control Style**: Fanuc-compatible G-code

## Database Schema

- `tools`: Tool library (name, type, diameter, angles, feeds, speeds)
- `projects`: Machining projects (name, geometry, toolpaths, settings)

## Development Commands

```bash
npm install          # Install dependencies
npm run dev          # Start development server (frontend + backend)
npm run build        # Build for production
npm run db:push      # Push schema to database
```

## Environment Variables

```
DATABASE_URL=postgresql://user:pass@host:5432/dbname
NODE_ENV=development|production
PORT=5000
```

## API Endpoints

- `GET /api/tools` - List all tools
- `POST /api/tools` - Create tool
- `GET /api/projects` - List projects
- `POST /api/projects` - Create project
- `GET /api/projects/:id` - Get project details
- `PUT /api/projects/:id` - Update project
- `DELETE /api/projects/:id` - Delete project
- `POST /api/cad/analyze` - Analyze CAD file
- `POST /api/cad/convert` - Convert 3DSOLID DXF to STL
- `POST /api/gcode/generate` - Generate G-code from project

## G-code Generation Logic

The generator creates toolpaths for:
- Roughing passes (configurable depth of cut)
- Finishing passes
- Threading operations
- Drilling/boring

Output follows Catek conventions with proper tool changes, spindle control, and safe positioning.

## Notes for Development

- The DXF parser handles multiple entity types: LINE, ARC, CIRCLE, POLYLINE, LWPOLYLINE, SPLINE, ELLIPSE, 3DFACE
- 3DSOLID entities contain ACIS data which requires external conversion (FreeCAD) for full geometry extraction
- Three.js canvas uses OrbitControls for 3D navigation
- Tool offsets are stored per-tool and applied during G-code generation
