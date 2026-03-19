# Lathe-Sculptor

CAM software for the Catek 7-in-1 CNC Wood Lathe. Import CAD files, visualize parts, and generate G-code.

![License](https://img.shields.io/badge/license-MIT-blue.svg)

## Features

- **CAD Import**: DXF, STL, OBJ, STEP file support
- **3D Visualization**: Real-time part preview with Three.js
- **Tool Library**: Manage lathe tools with feeds and speeds
- **G-code Generation**: Fanuc-style code for Catek controller
- **Project Management**: Save and organize machining jobs

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL database

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/lathe-sculptor.git
cd lathe-sculptor

# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your DATABASE_URL

# Push database schema
npm run db:push

# Start development server
npm run dev
```

Open http://localhost:5000

## Deployment

### Railway (Recommended)

1. Fork this repository
2. Create a new project on [Railway](https://railway.app)
3. Add a PostgreSQL database
4. Connect your GitHub repo
5. Railway auto-deploys on push

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/lathe-sculptor)

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `PORT` | Server port (default: 5000) | No |
| `NODE_ENV` | Environment (development/production) | No |

## Development

```bash
npm run dev      # Start dev server with hot reload
npm run build    # Build for production
npm run start    # Start production server
npm run db:push  # Push schema changes to database
```

## Tech Stack

- **Frontend**: React, TypeScript, Vite, Tailwind CSS, shadcn/ui, Three.js
- **Backend**: Node.js, Express, TypeScript
- **Database**: PostgreSQL, Drizzle ORM

## Machine Configuration

Designed for Catek 7-in-1 CNC Wood Lathe:
- 10-tool turret
- Fanuc-compatible control
- X-axis: diameter mode
- Z-axis: Z0 at spindle, negative toward tailstock

## License

MIT License - see [LICENSE](LICENSE) for details.

## Contributing

Pull requests welcome! Please read the contributing guidelines first.
