import { db } from "../server/db";
import { tools, projects } from "../shared/schema";
import * as fs from "fs";
import * as path from "path";

async function exportData() {
  console.log("Exporting development database data...");

  const dataDir = path.join(process.cwd(), "scripts", "seed-data");
  
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Export tools
  const allTools = await db.select().from(tools);
  const toolsExport = allTools.map(t => ({
    name: t.name,
    type: t.type,
    toolNumber: t.toolNumber,
    params: t.params
  }));
  
  fs.writeFileSync(
    path.join(dataDir, "tools.json"),
    JSON.stringify(toolsExport, null, 2)
  );
  console.log(`Exported ${allTools.length} tools to seed-data/tools.json`);

  // Export projects
  const allProjects = await db.select().from(projects);
  const projectsExport = allProjects.map(p => ({
    name: p.name,
    description: p.description || "",
    data: p.data
  }));
  
  fs.writeFileSync(
    path.join(dataDir, "projects.json"),
    JSON.stringify(projectsExport, null, 2)
  );
  console.log(`Exported ${allProjects.length} projects to seed-data/projects.json`);

  console.log("\nExport complete! Files saved to scripts/seed-data/");
  console.log("Run 'tsx scripts/seed-production.ts' after publishing to seed production database.");
  
  process.exit(0);
}

exportData().catch((err) => {
  console.error("Export failed:", err);
  process.exit(1);
});
