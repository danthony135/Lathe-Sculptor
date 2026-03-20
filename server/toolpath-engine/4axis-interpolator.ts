/**
 * 4-Axis Interpolator — Simultaneous X/Y/Z/A motion
 *
 * Generates toolpaths where the A-axis rotates DURING cutting for:
 * - Spiral flutes (helical grooves wrapping around workpiece)
 * - Wrapped patterns (project 2D design onto cylindrical surface)
 * - Helical paths (decorative spirals, barley twist)
 *
 * Handles inverse time feed rate calculation (G93) for combined
 * linear + rotary motion where surface speed varies with position.
 */

import type { ToolpathPoint, Point3D } from '@shared/schema';

// ============================================================
// TYPES
// ============================================================

export interface SpiralFluteOptions {
  stockRadius: number;       // mm
  stockLength: number;       // mm
  fluteCount: number;        // Number of flutes
  helixAngle: number;        // degrees — angle of helix relative to axis
  fluteDepth: number;        // mm — radial depth of flute
  toolRadius: number;        // mm
  feedRate: number;          // mm/min
  depthPerPass: number;      // mm — incremental radial depth
  startZ: number;            // mm
  endZ: number;              // mm
  safeRadius: number;        // mm
}

export interface WrappedPatternOptions {
  stockRadius: number;
  stockLength: number;
  toolRadius: number;
  feedRate: number;
  engravingDepth: number;    // mm
  safeRadius: number;
  // 2D pattern is defined as polylines in (u, v) space
  // u = 0..1 maps to startAngle..endAngle around circumference
  // v = 0..1 maps to startZ..endZ along length
  pattern: { u: number; v: number; pen: boolean }[]; // pen=false for rapids
  startAngle: number;        // degrees
  endAngle: number;          // degrees
  startZ: number;            // mm
  endZ: number;              // mm
}

export interface HelicalPathOptions {
  stockRadius: number;
  stockLength: number;
  pitch: number;             // mm per revolution
  depth: number;             // mm radial
  toolRadius: number;
  feedRate: number;
  depthPerPass: number;
  startZ: number;
  endZ: number;
  direction: 'left' | 'right'; // Left-hand or right-hand helix
  safeRadius: number;
}

// ============================================================
// SPIRAL FLUTE GENERATION
// ============================================================

/**
 * Generate spiral flute toolpath — helical grooves wrapping around workpiece.
 * Used for decorative twists, fluted columns, barley twist legs.
 */
export function generateSpiralFlutes(options: SpiralFluteOptions): ToolpathPoint[] {
  const {
    stockRadius, stockLength, fluteCount, helixAngle, fluteDepth,
    toolRadius, feedRate, depthPerPass, startZ, endZ, safeRadius,
  } = options;

  const toolpath: ToolpathPoint[] = [];
  const cutLength = Math.abs(endZ - startZ);

  // Helix angle determines how much the A-axis rotates per unit Z travel
  // tan(helixAngle) = circumference_travel / Z_travel
  // A_per_Z = tan(helixAngle) * 360 / (2π * stockRadius)
  const helixAngleRad = (helixAngle * Math.PI) / 180;
  const degreesPerMm = (Math.tan(helixAngleRad) * 360) / (2 * Math.PI * stockRadius);

  const totalAngle = cutLength * degreesPerMm;
  const numPasses = Math.ceil(fluteDepth / depthPerPass);

  // Generate each flute
  for (let flute = 0; flute < fluteCount; flute++) {
    const fluteStartAngle = (360 / fluteCount) * flute;

    // Multi-pass: rough to depth incrementally
    for (let pass = 1; pass <= numPasses; pass++) {
      const currentDepth = Math.min(pass * depthPerPass, fluteDepth);
      const cutRadius = stockRadius - currentDepth + toolRadius;

      // Rapid to start
      toolpath.push({
        x: safeRadius, y: 0,
        z: startZ,
        a: fluteStartAngle,
        moveType: 'rapid',
      });

      // Plunge to depth
      toolpath.push({
        x: cutRadius, y: 0,
        z: startZ,
        a: fluteStartAngle,
        feedRate: feedRate * 0.3, // Slow plunge
        moveType: 'linear',
      });

      // Helical cut: Z and A move simultaneously
      const steps = Math.ceil(cutLength / 0.5); // 0.5mm resolution along Z
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const z = startZ + (endZ - startZ) * t;
        const a = fluteStartAngle + totalAngle * t;

        // Calculate inverse time feed for this segment
        const inverseFeed = calculateInverseTimeFeed(
          feedRate, stockRadius, degreesPerMm, 1
        );

        toolpath.push({
          x: cutRadius, y: 0,
          z, a,
          feedRate: inverseFeed,
          moveType: 'linear',
        });
      }

      // Retract
      toolpath.push({
        x: safeRadius, y: 0,
        z: endZ,
        a: fluteStartAngle + totalAngle,
        moveType: 'rapid',
      });
    }
  }

  return toolpath;
}

// ============================================================
// WRAPPED PATTERN
// ============================================================

/**
 * Project a 2D pattern onto the cylindrical surface of the workpiece.
 * The pattern is defined in normalized (u, v) space where:
 * - u maps to angular position (A-axis)
 * - v maps to axial position (Z-axis)
 */
export function generateWrappedPattern(options: WrappedPatternOptions): ToolpathPoint[] {
  const {
    stockRadius, toolRadius, feedRate, engravingDepth, safeRadius,
    pattern, startAngle, endAngle, startZ, endZ,
  } = options;

  const toolpath: ToolpathPoint[] = [];
  const angleRange = endAngle - startAngle;
  const zRange = endZ - startZ;
  const cutRadius = stockRadius - engravingDepth + toolRadius;

  for (const point of pattern) {
    const a = startAngle + point.u * angleRange;
    const z = startZ + point.v * zRange;

    if (!point.pen) {
      // Rapid move (pen up)
      toolpath.push({
        x: safeRadius, y: 0, z, a,
        moveType: 'rapid',
      });
    } else {
      // Cutting move (pen down)
      toolpath.push({
        x: cutRadius, y: 0, z, a,
        feedRate,
        moveType: 'linear',
      });
    }
  }

  return toolpath;
}

// ============================================================
// HELICAL PATH
// ============================================================

/**
 * Generate a simple helical path (decorative spiral).
 * Like a spiral flute but with a single continuous path.
 */
export function generateHelicalPath(options: HelicalPathOptions): ToolpathPoint[] {
  const {
    stockRadius, pitch, depth, toolRadius, feedRate,
    depthPerPass, startZ, endZ, direction, safeRadius,
  } = options;

  const toolpath: ToolpathPoint[] = [];
  const cutLength = Math.abs(endZ - startZ);
  const totalRevolutions = cutLength / pitch;
  const totalAngle = totalRevolutions * 360;
  const dirMul = direction === 'left' ? 1 : -1;
  const numPasses = Math.ceil(depth / depthPerPass);

  for (let pass = 1; pass <= numPasses; pass++) {
    const currentDepth = Math.min(pass * depthPerPass, depth);
    const cutRadius = stockRadius - currentDepth + toolRadius;

    // Rapid to start
    toolpath.push({
      x: safeRadius, y: 0, z: startZ, a: 0,
      moveType: 'rapid',
    });

    // Plunge
    toolpath.push({
      x: cutRadius, y: 0, z: startZ, a: 0,
      feedRate: feedRate * 0.3,
      moveType: 'linear',
    });

    // Helical cut
    const stepsPerRev = 36; // 10° resolution
    const totalSteps = Math.ceil(totalRevolutions * stepsPerRev);

    for (let i = 0; i <= totalSteps; i++) {
      const t = i / totalSteps;
      const z = startZ + (endZ - startZ) * t;
      const a = dirMul * totalAngle * t;

      toolpath.push({
        x: cutRadius, y: 0, z, a,
        feedRate,
        moveType: 'linear',
      });
    }

    // Retract
    toolpath.push({
      x: safeRadius, y: 0,
      z: endZ, a: dirMul * totalAngle,
      moveType: 'rapid',
    });
  }

  return toolpath;
}

// ============================================================
// INVERSE TIME FEED CALCULATION
// ============================================================

/**
 * Calculate G93 inverse time feed rate for combined linear + rotary motion.
 *
 * In inverse time mode, F = 1/time (minutes) for each block.
 * We need to calculate the total time for a combined XYZ linear move
 * plus an A-axis rotary move, at the desired surface speed.
 *
 * Surface speed at the cutting point depends on the workpiece radius
 * and the angular velocity, plus the linear feed component.
 *
 * totalDistance = sqrt(linearDist² + arcDist²)
 * arcDist = (deltaA / 360) * 2π * radius
 * time = totalDistance / desiredFeedRate
 * inverseTimeFeed = 1 / time
 */
export function calculateInverseTimeFeed(
  desiredFeedRate: number,  // mm/min surface speed
  radius: number,           // mm — workpiece radius at cutting point
  deltaAngle: number,       // degrees of A-axis rotation in this segment
  linearDistance: number     // mm of linear (XYZ) travel in this segment
): number {
  const arcDistance = (Math.abs(deltaAngle) / 360) * 2 * Math.PI * radius;
  const totalDistance = Math.sqrt(linearDistance * linearDistance + arcDistance * arcDistance);

  if (totalDistance < 0.001) return 1.0; // Avoid division by zero

  const timeMinutes = totalDistance / desiredFeedRate;
  return 1 / timeMinutes; // Inverse time feed value
}

/**
 * Convert a toolpath with standard feed rates to inverse time feed (G93).
 * Each segment's F value is recalculated based on combined motion.
 */
export function convertToInverseTime(
  toolpath: ToolpathPoint[],
  desiredFeedRate: number,
  stockRadius: number
): ToolpathPoint[] {
  const result: ToolpathPoint[] = [];

  for (let i = 0; i < toolpath.length; i++) {
    const point = { ...toolpath[i] };

    if (point.moveType === 'rapid' || i === 0) {
      result.push(point);
      continue;
    }

    const prev = toolpath[i - 1];
    const dx = point.x - prev.x;
    const dy = point.y - prev.y;
    const dz = point.z - prev.z;
    const da = (point.a || 0) - (prev.a || 0);
    const linearDist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    point.feedRate = calculateInverseTimeFeed(
      desiredFeedRate, stockRadius, da, linearDist
    );
    result.push(point);
  }

  return result;
}
