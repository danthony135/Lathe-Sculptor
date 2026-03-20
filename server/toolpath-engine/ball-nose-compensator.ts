/**
 * Ball Nose Compensator — Tool geometry compensation for 3D surface machining
 *
 * A ball-nose end mill's effective cutting diameter changes with depth of cut.
 * At the very tip it's 0, at full radius it's the nominal diameter.
 * This module calculates the correct tool center position to achieve
 * the desired surface contact point.
 */

import type { Point3D } from '@shared/schema';

export interface BallNoseParams {
  diameter: number;       // mm — nominal diameter
  cornerRadius: number;   // mm — same as diameter/2 for full ball nose
  neckDiameter: number;   // mm — shank diameter above the ball
}

/**
 * Calculate the effective cutting radius at a given depth on a ball-nose tool.
 * At the tip (depth=0), effective radius = 0.
 * At full engagement (depth=R), effective radius = R.
 */
export function effectiveRadius(toolRadius: number, depthOfCut: number): number {
  if (depthOfCut <= 0) return 0;
  if (depthOfCut >= toolRadius) return toolRadius;
  // From circle geometry: r_eff = sqrt(R² - (R-d)²) = sqrt(2Rd - d²)
  return Math.sqrt(2 * toolRadius * depthOfCut - depthOfCut * depthOfCut);
}

/**
 * Calculate stepover for a target scallop height with a ball-nose tool.
 * Scallop height = the ridge height between adjacent passes.
 *
 * For a flat surface: stepover = 2 * sqrt(2*R*h - h²)
 * where R = tool radius, h = scallop height
 */
export function stepoverForScallop(toolRadius: number, scallopHeight: number): number {
  if (scallopHeight <= 0) return 0;
  if (scallopHeight >= toolRadius) return toolRadius * 2;
  return 2 * Math.sqrt(2 * toolRadius * scallopHeight - scallopHeight * scallopHeight);
}

/**
 * Calculate the tool center position (CL point) given a surface contact point
 * and surface normal. The ball-nose tip touches the surface, and the tool
 * center is offset by the tool radius along the surface normal.
 *
 * CL_point = surface_point + toolRadius * surface_normal
 */
export function clPointFromContact(
  contactPoint: Point3D,
  surfaceNormal: Point3D,
  toolRadius: number
): Point3D {
  return {
    x: contactPoint.x + toolRadius * surfaceNormal.x,
    y: contactPoint.y + toolRadius * surfaceNormal.y,
    z: contactPoint.z + toolRadius * surfaceNormal.z,
  };
}

/**
 * For a turned surface (cylindrical), the surface normal at any point
 * is simply the radial direction outward from the centerline.
 */
export function cylindricalNormal(angle: number): Point3D {
  const rad = (angle * Math.PI) / 180;
  return {
    x: Math.cos(rad),
    y: Math.sin(rad),
    z: 0,
  };
}

/**
 * Calculate scallop height on a curved surface (adjustment for surface curvature).
 * On convex surfaces, actual scallop is less than flat. On concave, it's more.
 *
 * h_actual ≈ h_flat * R_tool / (R_tool + R_surface)  for convex
 * h_actual ≈ h_flat * R_tool / (R_tool - R_surface)  for concave (R_tool > R_surface)
 */
export function adjustedScallopHeight(
  flatScallop: number,
  toolRadius: number,
  surfaceRadius: number,
  isConvex: boolean
): number {
  if (isConvex) {
    return flatScallop * toolRadius / (toolRadius + surfaceRadius);
  }
  if (surfaceRadius >= toolRadius) {
    return flatScallop * 2; // Can't properly cut concave tighter than tool
  }
  return flatScallop * toolRadius / (toolRadius - surfaceRadius);
}
