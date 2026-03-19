import { db } from "../server/db";
import { tools, projects } from "../shared/schema";
import * as fs from "fs";
import * as path from "path";

const dataDir = path.join(process.cwd(), "scripts", "seed-data");

async function seed() {
  console.log("Starting production database seed...");

  // Check if seed data exists
  const toolsFile = path.join(dataDir, "tools.json");
  const projectsFile = path.join(dataDir, "projects.json");

  if (!fs.existsSync(toolsFile)) {
    console.log("No seed data found. Run 'tsx scripts/export-data.ts' first to export your development data.");
    process.exit(1);
  }

  // Seed tools
  const existingTools = await db.select().from(tools);
  if (existingTools.length > 0) {
    console.log(`Database already has ${existingTools.length} tools. Skipping tool seed.`);
  } else {
    const seedTools = JSON.parse(fs.readFileSync(toolsFile, "utf-8"));
    console.log(`Seeding ${seedTools.length} tools...`);
    
    for (const tool of seedTools) {
      await db.insert(tools).values(tool);
      console.log(`  Added tool: ${tool.name}`);
    }
  }

  // Seed projects
  if (fs.existsSync(projectsFile)) {
    const existingProjects = await db.select().from(projects);
    if (existingProjects.length > 0) {
      console.log(`Database already has ${existingProjects.length} projects. Skipping project seed.`);
    } else {
      const seedProjects = JSON.parse(fs.readFileSync(projectsFile, "utf-8"));
      console.log(`Seeding ${seedProjects.length} projects...`);
      
      for (const project of seedProjects) {
        await db.insert(projects).values(project);
        console.log(`  Added project: ${project.name}`);
      }
    }
  }

  console.log("\nSeed complete!");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
