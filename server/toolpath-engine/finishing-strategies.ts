/**
 * Finishing Strategies — Generate surface-following toolpaths from height maps
 *
 * Supported strategies:
 * - Raster (zigzag): Back-and-forth passes along Z at incrementing angles
 * - Spiral: Continuous spiral from one end to the other
 * - Constant-Z: Horizontal slicing at constant radial depth
 * - Flowline: Follow surface contours (simplified)
 * - Pencil: Trace concave valleys and sharp features
 */

import type { ToolpathPoint, Carving3DParams } from '@shared/schema';
import type { SurfaceSample } from './surface-sampler';
import { stepoverForScallop, clPointFromContact, cylindricalNormal } from './ball-nose-compensator';

export interface FinishingOptions {
  strategy: Carving3DParams['finishingStrategy'];
  toolRadius: number;        // mm
  scallopHeight: number;     // mm target
  stockRadius: number;       // mm
  stockLength: number;       // mm
  rasterAngle?: number;      // degrees for raster direction
  spiralPitch?: number;      // mm per revolution for spiral
  boundaryOffset: number;    // mm offset from stock edge
  feedRate: number;          // mm/min
  safeRadius: number;        // mm — retract radius
}

/**
 * Generate finishing toolpath from surface samples.
 * Dispatches to the appropriate strategy.
 */
export function generateFinishingToolpath(
  samples: SurfaceSample[][],
  options: FinishingOptions
): ToolpathPoint[] {
  switch (options.strategy) {
    case 'raster':
      return generateRasterToolpath(samples, options);
    case 'spiral':
      return generateSpiralToolpath(samples, options);
    case 'constant_z':
      return generateConstantZToolpath(samples, options);
    case 'flowline':
      return generateFlowlineToolpath(samples, options);
    case 'pencil':
      return generatePencilToolpath(samples, options);
    default:
      return generateRasterToolpath(samples, options);
  }
}

/**
 * Raster (zigzag) finishing — passes along Z axis at each A-axis angle.
 * Most common strategy for general 3D surfaces.
 */
function generateRasterToolpath(
  samples: SurfaceSample[][],
  options: FinishingOptions
): ToolpathPoint[] {
  const toolpath: ToolpathPoint[] = [];
  const { toolRadius, scallopHeight, stockRadius, safeRadius, feedRate, boundaryOffset } = options;
  const stepover = stepoverForScallop(toolRadius, scallopHeight);
  const angleStep = (stepover / (stockRadius * Math.PI)) * 180; // Convert linear stepover to angular

  if (samples.length === 0 || samples[0].length === 0) return toolpath;

  const angleCount = samples[0].length;
  const angleResolution = 360 / angleCount;
  const passCount = Math.ceil(360 / angleStep);

  let direction = 1; // 1 = forward (Z0 to -Z), -1 = reverse

  for (let pass = 0; pass < passCount; pass++) {
    const targetAngle = pass * angleStep;
    // Find nearest sampled angle
    const angleIdx = Math.round(targetAngle / angleResolution) % angleCount;
    const angle = angleIdx * angleResolution;

    // Rapid to start position
    toolpath.push({
      x: safeRadius, y: 0, z: direction > 0 ? boundaryOffset : -(options.stockLength - boundaryOffset),
      a: angle, moveType: 'rapid',
    });

    // Traverse along Z
    const zIndices = direction > 0
      ? Array.from({ length: samples.length }, (_, i) => i)
      : Array.from({ length: samples.length }, (_, i) => samples.length - 1 - i);

    for (const zi of zIndices) {
      const row = samples[zi];
      if (!row[angleIdx]) continue;

      const sample = row[angleIdx];
      const normal = cylindricalNormal(angle);

      // CL point: offset tool center from surface by tool radius
      const cl = clPointFromContact(
        { x: sample.radius * Math.cos(angle * Math.PI / 180),
          y: sample.radius * Math.sin(angle * Math.PI / 180),
          z: sample.z },
        normal,
        toolRadius
      );

      const clRadius = Math.sqrt(cl.x * cl.x + cl.y * cl.y);

      toolpath.push({
        x: clRadius,
        y: 0,
        z: sample.z,
        a: angle,
        feedRate,
        moveType: 'linear',
      });
    }

    // Retract
    toolpath.push({
      x: safeRadius, y: 0,
      z: direction > 0 ? -(options.stockLength - boundaryOffset) : boundaryOffset,
      a: angle, moveType: 'rapid',
    });

    direction *= -1; // Zigzag
  }

  return toolpath;
}

/**
 * Spiral finishing — continuous helical path wrapping around the workpiece.
 * Good for smooth, continuous surfaces.
 */
function generateSpiralToolpath(
  samples: SurfaceSample[][],
  options: FinishingOptions
): ToolpathPoint[] {
  const toolpath: ToolpathPoint[] = [];
  const { toolRadius, scallopHeight, stockRadius, stockLength, safeRadius, feedRate, boundaryOffset } = options;
  const pitch = options.spiralPitch || stepoverForScallop(toolRadius, scallopHeight);

  if (samples.length === 0 || samples[0].length === 0) return toolpath;

  const angleCount = samples[0].length;
  const angleResolution = 360 / angleCount;
  const totalRevolutions = stockLength / pitch;
  const totalSteps = Math.ceil(totalRevolutions * angleCount);

  // Start position
  toolpath.push({
    x: safeRadius, y: 0, z: boundaryOffset,
    a: 0, moveType: 'rapid',
  });

  for (let step = 0; step <= totalSteps; step++) {
    const angle = (step * angleResolution) % 360;
    const z = -(step / angleCount) * pitch;

    if (z < -(stockLength - boundaryOffset)) break;

    // Find closest sample
    const angleIdx = Math.round(angle / angleResolution) % angleCount;
    const zIdx = Math.min(
      Math.round(Math.abs(z) / (stockLength / samples.length)),
      samples.length - 1
    );

    const sample = samples[zIdx]?.[angleIdx];
    if (!sample) continue;

    const normal = cylindricalNormal(angle);
    const cl = clPointFromContact(
      { x: sample.radius * Math.cos(angle * Math.PI / 180),
        y: sample.radius * Math.sin(angle * Math.PI / 180),
        z: z },
      normal,
      toolRadius
    );

    const clRadius = Math.sqrt(cl.x * cl.x + cl.y * cl.y);

    toolpath.push({
      x: clRadius, y: 0, z,
      a: angle,
      feedRate,
      moveType: 'linear',
    });
  }

  // Retract
  toolpath.push({
    x: safeRadius, y: 0,
    z: -(stockLength - boundaryOffset),
    a: 0, moveType: 'rapid',
  });

  return toolpath;
}

/**
 * Constant-Z finishing — horizontal slices at constant radial depth.
 * Good for steep-walled features.
 */
function generateConstantZToolpath(
  samples: SurfaceSample[][],
  options: FinishingOptions
): ToolpathPoint[] {
  const toolpath: ToolpathPoint[] = [];
  const { toolRadius, scallopHeight, stockRadius, safeRadius, feedRate } = options;
  const stepdown = scallopHeight * 4; // Larger steps for constant-Z

  if (samples.length === 0 || samples[0].length === 0) return toolpath;

  const angleCount = samples[0].length;
  const angleResolution = 360 / angleCount;

  // Find min/max radius across all samples
  let minRadius = stockRadius;
  for (const row of samples) {
    for (const s of row) {
      minRadius = Math.min(minRadius, s.radius);
    }
  }

  // Generate contours at each depth level
  const depthSteps = Math.ceil((stockRadius - minRadius) / stepdown);

  for (let di = 0; di <= depthSteps; di++) {
    const targetRadius = stockRadius - di * stepdown;
    if (targetRadius < minRadius) break;

    // For each Z row, trace the contour at this radius
    for (let zi = 0; zi < samples.length; zi++) {
      const row = samples[zi];
      let hasContact = false;

      for (let ai = 0; ai <= angleCount; ai++) {
        const angleIdx = ai % angleCount;
        const sample = row[angleIdx];
        if (!sample) continue;

        if (sample.radius <= targetRadius + toolRadius) {
          if (!hasContact) {
            // Rapid to approach
            toolpath.push({
              x: safeRadius, y: 0, z: sample.z,
              a: sample.angle, moveType: 'rapid',
            });
            hasContact = true;
          }

          toolpath.push({
            x: targetRadius + toolRadius,
            y: 0,
            z: sample.z,
            a: sample.angle,
            feedRate,
            moveType: 'linear',
          });
        }
      }

      if (hasContact) {
        toolpath.push({
          x: safeRadius, y: 0, z: row[0].z,
          a: 0, moveType: 'rapid',
        });
      }
    }
  }

  return toolpath;
}

/**
 * Flowline finishing — follow surface contours.
 * Simplified: follows the profile at each angle, similar to raster but
 * with passes oriented along the surface flow direction.
 */
function generateFlowlineToolpath(
  samples: SurfaceSample[][],
  options: FinishingOptions
): ToolpathPoint[] {
  // For a lathe workpiece, flowline along Z is essentially the same as raster
  // The difference matters more for freeform surfaces
  return generateRasterToolpath(samples, options);
}

/**
 * Pencil finishing — trace concave valleys and sharp radius changes.
 * Finds areas where surface curvature is high (concave features)
 * and generates passes only along those features.
 */
function generatePencilToolpath(
  samples: SurfaceSample[][],
  options: FinishingOptions
): ToolpathPoint[] {
  const toolpath: ToolpathPoint[] = [];
  const { toolRadius, safeRadius, feedRate } = options;

  if (samples.length < 3 || samples[0].length < 3) return toolpath;

  const angleCount = samples[0].length;
  const angleResolution = 360 / angleCount;

  // Find concave features by looking for sharp radius changes
  for (let zi = 1; zi < samples.length - 1; zi++) {
    for (let ai = 0; ai < angleCount; ai++) {
      const curr = samples[zi][ai];
      const prevZ = samples[zi - 1][ai];
      const nextZ = samples[zi + 1][ai];
      const prevA = samples[zi][(ai - 1 + angleCount) % angleCount];
      const nextA = samples[zi][(ai + 1) % angleCount];

      // Second derivative of radius (curvature estimate)
      const d2z = prevZ.radius - 2 * curr.radius + nextZ.radius;
      const d2a = prevA.radius - 2 * curr.radius + nextA.radius;

      // If curvature is strongly concave (positive second derivative)
      if (d2z > toolRadius * 0.1 || d2a > toolRadius * 0.1) {
        toolpath.push({
          x: curr.radius + toolRadius,
          y: 0,
          z: curr.z,
          a: curr.angle,
          feedRate,
          moveType: 'linear',
        });
      }
    }
  }

  // Sort pencil points into continuous passes (group by angle proximity)
  // For simplicity, just return all points — a full implementation would
  // cluster them into connected passes with rapid moves between

  return toolpath;
}

/**
 * Generate roughing toolpath using waterline (constant-Z) strategy.
 * Removes bulk material in layers before finishing.
 */
export function generateRoughingToolpath(
  samples: SurfaceSample[][],
  options: {
    toolRadius: number;
    stepdown: number;      // mm per roughing level
    stockRadius: number;
    stockLength: number;
    safeRadius: number;
    feedRate: number;
    finishAllowance: number; // mm to leave for finishing
  }
): ToolpathPoint[] {
  const toolpath: ToolpathPoint[] = [];
  const { toolRadius, stepdown, stockRadius, safeRadius, feedRate, finishAllowance } = options;

  if (samples.length === 0 || samples[0].length === 0) return toolpath;

  const angleCount = samples[0].length;
  const angleResolution = 360 / angleCount;

  // Find minimum radius (deepest cut)
  let minRadius = stockRadius;
  for (const row of samples) {
    for (const s of row) {
      minRadius = Math.min(minRadius, s.radius);
    }
  }

  // Leave finish allowance
  const roughTarget = minRadius + finishAllowance;

  // Rough from stock surface down in steps
  let currentRadius = stockRadius;

  while (currentRadius > roughTarget + stepdown) {
    currentRadius -= stepdown;

    // Full 360° pass at this depth for each Z position
    for (let zi = 0; zi < samples.length; zi++) {
      const row = samples[zi];

      // Check if any sample at this Z is deeper than current level
      const needsCut = row.some(s => s.radius < currentRadius);
      if (!needsCut) continue;

      // Approach
      toolpath.push({
        x: safeRadius, y: 0, z: row[0].z,
        a: 0, moveType: 'rapid',
      });

      // Cut full circle at this depth
      for (let ai = 0; ai <= angleCount; ai++) {
        const angle = (ai % angleCount) * angleResolution;
        toolpath.push({
          x: currentRadius + toolRadius,
          y: 0,
          z: row[0].z,
          a: angle,
          feedRate,
          moveType: 'linear',
        });
      }

      // Retract
      toolpath.push({
        x: safeRadius, y: 0, z: row[0].z,
        a: 0, moveType: 'rapid',
      });
    }
  }

  return toolpath;
}
