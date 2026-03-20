/**
 * Surface Sampler — Sample STL/OBJ mesh at regular grid points
 *
 * Takes a triangle mesh and samples the surface height at a regular
 * grid of points for toolpath generation. Uses ray casting to find
 * the surface Z (radial) value at each (X, theta) grid point.
 */

import type { Point3D, ToolpathPoint } from '@shared/schema';

export interface MeshTriangle {
  v0: Point3D;
  v1: Point3D;
  v2: Point3D;
  normal?: Point3D;
}

export interface SurfaceSample {
  z: number;           // Along workpiece axis
  angle: number;       // A-axis angle (degrees)
  radius: number;      // Distance from centerline
  normal: Point3D;     // Surface normal at this point
}

export interface SamplerOptions {
  zResolution: number;     // mm between Z samples
  angleResolution: number; // degrees between angle samples
  stockRadius: number;     // mm — maximum radius (stock surface)
  stockLength: number;     // mm
}

/**
 * Extract triangles from flat vertex/index arrays (STL/OBJ format)
 */
export function extractTriangles(
  vertices: number[],
  normals?: number[],
  indices?: number[]
): MeshTriangle[] {
  const triangles: MeshTriangle[] = [];

  if (indices && indices.length > 0) {
    for (let i = 0; i < indices.length; i += 3) {
      const i0 = indices[i] * 3;
      const i1 = indices[i + 1] * 3;
      const i2 = indices[i + 2] * 3;
      triangles.push({
        v0: { x: vertices[i0], y: vertices[i0 + 1], z: vertices[i0 + 2] },
        v1: { x: vertices[i1], y: vertices[i1 + 1], z: vertices[i1 + 2] },
        v2: { x: vertices[i2], y: vertices[i2 + 1], z: vertices[i2 + 2] },
      });
    }
  } else {
    // Non-indexed — every 9 values = 1 triangle
    for (let i = 0; i < vertices.length; i += 9) {
      triangles.push({
        v0: { x: vertices[i], y: vertices[i + 1], z: vertices[i + 2] },
        v1: { x: vertices[i + 3], y: vertices[i + 4], z: vertices[i + 5] },
        v2: { x: vertices[i + 6], y: vertices[i + 7], z: vertices[i + 8] },
      });
    }
  }

  // Compute normals if not provided
  for (const tri of triangles) {
    if (!tri.normal) {
      tri.normal = computeTriangleNormal(tri);
    }
  }

  return triangles;
}

/**
 * Sample mesh surface at a regular cylindrical grid.
 * For each (z, angle) position, cast a ray inward from stock surface
 * to find where it hits the mesh. The hit distance = surface radius.
 */
export function sampleSurface(
  triangles: MeshTriangle[],
  options: SamplerOptions
): SurfaceSample[][] {
  const { zResolution, angleResolution, stockRadius, stockLength } = options;

  const zSteps = Math.ceil(stockLength / zResolution);
  const angleSteps = Math.ceil(360 / angleResolution);
  const samples: SurfaceSample[][] = [];

  for (let zi = 0; zi <= zSteps; zi++) {
    const z = -(zi * zResolution); // Negative Z = toward tailstock
    const row: SurfaceSample[] = [];

    for (let ai = 0; ai < angleSteps; ai++) {
      const angle = ai * angleResolution;
      const angleRad = (angle * Math.PI) / 180;

      // Ray origin: on stock surface at this angle
      const rayOriginX = stockRadius * Math.cos(angleRad);
      const rayOriginY = stockRadius * Math.sin(angleRad);

      // Ray direction: inward toward center
      const rayDirX = -Math.cos(angleRad);
      const rayDirY = -Math.sin(angleRad);

      // Cast ray against all triangles
      let closestHit = stockRadius; // Default to stock surface
      let hitNormal: Point3D = { x: rayDirX, y: rayDirY, z: 0 };

      for (const tri of triangles) {
        const hit = rayTriangleIntersect(
          { x: rayOriginX, y: rayOriginY, z: z },
          { x: rayDirX, y: rayDirY, z: 0 },
          tri
        );
        if (hit !== null && hit < closestHit) {
          closestHit = stockRadius - hit; // Convert distance to radius
          hitNormal = tri.normal || hitNormal;
        }
      }

      row.push({
        z,
        angle,
        radius: Math.max(0.5, closestHit), // Min radius to avoid center
        normal: hitNormal,
      });
    }

    samples.push(row);
  }

  return samples;
}

/**
 * Convert surface samples to a height map (radius at each z,angle)
 */
export function samplesToHeightMap(
  samples: SurfaceSample[][]
): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of samples) {
    for (const s of row) {
      map.set(`${s.z.toFixed(1)},${s.angle.toFixed(1)}`, s.radius);
    }
  }
  return map;
}

// ============================================================
// GEOMETRY HELPERS
// ============================================================

function computeTriangleNormal(tri: MeshTriangle): Point3D {
  const ux = tri.v1.x - tri.v0.x;
  const uy = tri.v1.y - tri.v0.y;
  const uz = tri.v1.z - tri.v0.z;
  const vx = tri.v2.x - tri.v0.x;
  const vy = tri.v2.y - tri.v0.y;
  const vz = tri.v2.z - tri.v0.z;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  return len > 0 ? { x: nx / len, y: ny / len, z: nz / len } : { x: 0, y: 0, z: 1 };
}

/**
 * Möller–Trumbore ray-triangle intersection
 * Returns distance along ray, or null if no hit
 */
function rayTriangleIntersect(
  origin: Point3D,
  direction: Point3D,
  tri: MeshTriangle
): number | null {
  const EPSILON = 0.000001;

  const e1x = tri.v1.x - tri.v0.x;
  const e1y = tri.v1.y - tri.v0.y;
  const e1z = tri.v1.z - tri.v0.z;
  const e2x = tri.v2.x - tri.v0.x;
  const e2y = tri.v2.y - tri.v0.y;
  const e2z = tri.v2.z - tri.v0.z;

  // Cross product of direction and e2
  const px = direction.y * e2z - direction.z * e2y;
  const py = direction.z * e2x - direction.x * e2z;
  const pz = direction.x * e2y - direction.y * e2x;

  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < EPSILON) return null;

  const invDet = 1 / det;

  const tx = origin.x - tri.v0.x;
  const ty = origin.y - tri.v0.y;
  const tz = origin.z - tri.v0.z;

  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u < 0 || u > 1) return null;

  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;

  const v = (direction.x * qx + direction.y * qy + direction.z * qz) * invDet;
  if (v < 0 || u + v > 1) return null;

  const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  if (t < EPSILON) return null;

  return t;
}
