import { execSync } from "child_process";
import * as esbuild from "esbuild";
import * as path from "path";
import * as fs from "fs";

const rootDir = path.resolve(import.meta.dirname, "..");

// Step 1: Build frontend with Vite
console.log("Building frontend...");
execSync("npx vite build", { cwd: rootDir, stdio: "inherit" });

// Step 2: Bundle server with esbuild
console.log("Building server...");

// Read package.json to get all dependencies as externals
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf-8"));
const externalDeps = [
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.devDependencies || {}),
  ...Object.keys(pkg.optionalDependencies || {}),
];

await esbuild.build({
  entryPoints: [path.join(rootDir, "server", "index.ts")],
  outfile: path.join(rootDir, "dist", "index.cjs"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  packages: "external",
  alias: {
    "@shared": path.join(rootDir, "shared"),
  },
  define: {
    "import.meta.dirname": "__dirname",
  },
});

console.log("Build complete!");
