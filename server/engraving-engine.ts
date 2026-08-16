/**
 * Engraving Engine — Text and SVG to Toolpath Conversion
 *
 * Converts text strings (via opentype.js font parsing) and SVG path data
 * into ToolpathPoint[] arrays for the G-code generator.
 *
 * Coordinate mapping (engraving on the cylindrical surface):
 * - Glyph X (along the text baseline) → machine Z, starting at startZ and
 *   running toward the tailstock (negative Z direction)
 * - Glyph Y (glyph height) → A-axis rotation, as arc length on the surface
 *   at radius xOffset (opentype uses y-down coordinates, so +glyph-y maps
 *   to negative rotation)
 * - Toolpath x is the radial contact position: xOffset - engravingDepth
 *   while cutting, xOffset + 2 retracted
 *
 * V-bit depth calculation: depth = (lineWidth / 2) / tan(bitAngle / 2)
 */

import opentype from 'opentype.js';
import path from 'path';
import fs from 'fs';
import type { ToolpathPoint, Point3D } from '@shared/schema';

// ============================================================
// TYPES
// ============================================================

export interface EngravingOptions {
  text: string;
  fontSize: number;          // mm height
  fontPath?: string;         // Path to .ttf/.otf font file
  engravingDepth: number;    // mm (constant depth for single-line engraving)
  vBitAngle?: number;        // degrees — if set, depth varies with stroke width
  startZ: number;            // mm — Z position where text starts
  xOffset: number;           // mm — radial offset from center (surface radius)
  letterSpacing?: number;    // mm extra spacing between characters
  lineHeight?: number;       // mm for multi-line text
  tolerance?: number;        // mm — curve approximation tolerance (smaller = more points)
}

export interface SvgEngravingOptions {
  svgPathData: string;       // SVG path "d" attribute
  scale: number;             // Scale factor to convert SVG units to mm
  engravingDepth: number;
  startZ: number;
  xOffset: number;
  tolerance?: number;
}

// ============================================================
// SHARED EMITTER
// ============================================================

/**
 * Accumulates toolpath points for engraving strokes in a 2D plane
 * (u = mm along the baseline, v = mm perpendicular / glyph height, y-down)
 * and maps them onto the machine axes.
 */
class StrokeEmitter {
  readonly toolpath: ToolpathPoint[] = [];
  private penDown = false;
  private lastU = 0;
  private lastV = 0;

  constructor(
    private startZ: number,
    private surfaceRadius: number,
    private engravingDepth: number,
  ) {}

  /** Convert planar (u, v) to machine coordinates */
  private map(u: number, v: number): { z: number; a: number } {
    const z = this.startZ - u;
    // Arc length v on the surface → rotation angle; y-down means positive v
    // rotates negative. Guard against a zero radius.
    const r = Math.max(this.surfaceRadius, 0.001);
    const a = -(v / r) * (180 / Math.PI);
    return { z, a };
  }

  get position(): { u: number; v: number } {
    return { u: this.lastU, v: this.lastV };
  }

  /** Lift the tool and rapid to a new planar position */
  moveTo(u: number, v: number) {
    const { z, a } = this.map(u, v);
    this.toolpath.push({
      x: this.surfaceRadius + 2, y: 0, z, a, moveType: 'rapid',
    });
    // Plunge to depth at the new position
    this.toolpath.push({
      x: this.surfaceRadius - this.engravingDepth, y: 0, z, a, moveType: 'linear',
    });
    this.lastU = u;
    this.lastV = v;
    this.penDown = true;
  }

  /** Cut a straight stroke to a planar position */
  lineTo(u: number, v: number) {
    if (!this.penDown) {
      this.moveTo(u, v);
      return;
    }
    const { z, a } = this.map(u, v);
    this.toolpath.push({
      x: this.surfaceRadius - this.engravingDepth, y: 0, z, a, moveType: 'linear',
    });
    this.lastU = u;
    this.lastV = v;
  }

  /** Tessellate a cubic bezier into strokes */
  cubicTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number, tolerance: number) {
    const len = bezierLength(this.lastU, this.lastV, x1, y1, x2, y2, x, y);
    const steps = Math.max(4, Math.ceil(len / tolerance));
    const { u: u0, v: v0 } = this.position;
    for (let i = 1; i <= steps; i++) {
      const pt = cubicBezierPoint(u0, v0, x1, y1, x2, y2, x, y, i / steps);
      this.lineTo(pt.x, pt.y);
    }
  }

  /** Tessellate a quadratic bezier into strokes */
  quadTo(x1: number, y1: number, x: number, y: number, tolerance: number) {
    const len = quadBezierLength(this.lastU, this.lastV, x1, y1, x, y);
    const steps = Math.max(3, Math.ceil(len / tolerance));
    const { u: u0, v: v0 } = this.position;
    for (let i = 1; i <= steps; i++) {
      const pt = quadBezierPoint(u0, v0, x1, y1, x, y, i / steps);
      this.lineTo(pt.x, pt.y);
    }
  }

  /** Retract the tool */
  lift() {
    if (!this.penDown) return;
    const { z, a } = this.map(this.lastU, this.lastV);
    this.toolpath.push({
      x: this.surfaceRadius + 2, y: 0, z, a, moveType: 'rapid',
    });
    this.penDown = false;
  }
}

// ============================================================
// TEXT TO TOOLPATH
// ============================================================

/**
 * Convert text string to engraving toolpath using font glyph outlines.
 * Each character's outline paths become cutting moves.
 * Rapid moves between characters/paths.
 */
export async function textToToolpath(options: EngravingOptions): Promise<ToolpathPoint[]> {
  const {
    text,
    fontSize,
    fontPath,
    engravingDepth,
    startZ,
    xOffset,
    letterSpacing = 0,
    tolerance = 0.2,
  } = options;

  // Load font — use bundled font or specified path
  let font: opentype.Font | null = null;
  if (fontPath && fs.existsSync(fontPath)) {
    font = opentype.loadSync(fontPath);
  } else {
    // Try to load a system font as fallback
    const systemFonts = [
      '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
      '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
      'C:/Windows/Fonts/arial.ttf',
      'C:/Windows/Fonts/consola.ttf',
    ];
    for (const fp of systemFonts) {
      if (fs.existsSync(fp)) {
        font = opentype.loadSync(fp);
        break;
      }
    }
    if (!font) {
      throw new Error('No font file found. Provide a fontPath or install system fonts.');
    }
  }

  // getPaths(text, 0, 0, fontSize) returns coordinates ALREADY scaled to
  // fontSize units (mm here) with glyph advances and kerning applied —
  // no further scaling is needed.
  const glyphPaths = font.getPaths(text, 0, 0, fontSize);
  const emitter = new StrokeEmitter(startZ, xOffset, engravingDepth);

  glyphPaths.forEach((glyphPath, glyphIndex) => {
    const commands = glyphPath.commands;
    if (!commands || commands.length === 0) return;

    // Optional extra tracking between characters
    const spacing = letterSpacing * glyphIndex;
    let contourStart: { u: number; v: number } | null = null;

    for (const cmd of commands) {
      switch (cmd.type) {
        case 'M':
          emitter.lift();
          emitter.moveTo(cmd.x! + spacing, cmd.y!);
          contourStart = { u: cmd.x! + spacing, v: cmd.y! };
          break;
        case 'L':
          emitter.lineTo(cmd.x! + spacing, cmd.y!);
          break;
        case 'C':
          emitter.cubicTo(
            cmd.x1! + spacing, cmd.y1!,
            cmd.x2! + spacing, cmd.y2!,
            cmd.x! + spacing, cmd.y!,
            tolerance
          );
          break;
        case 'Q':
          emitter.quadTo(
            cmd.x1! + spacing, cmd.y1!,
            cmd.x! + spacing, cmd.y!,
            tolerance
          );
          break;
        case 'Z':
          // Close the contour back to its starting point, then lift
          if (contourStart) emitter.lineTo(contourStart.u, contourStart.v);
          emitter.lift();
          break;
      }
    }
    emitter.lift();
  });

  return emitter.toolpath;
}

// ============================================================
// SVG PATH TO TOOLPATH
// ============================================================

/**
 * Parse SVG path "d" attribute and convert to engraving toolpath.
 * Supports M, L, H, V, C, Q, Z (S/T/A are approximated by their
 * parsed absolute endpoints via the parser below).
 */
export function svgPathToToolpath(options: SvgEngravingOptions): ToolpathPoint[] {
  const { svgPathData, scale, engravingDepth, startZ, xOffset, tolerance = 0.2 } = options;

  const commands = parseSvgPath(svgPathData);
  const emitter = new StrokeEmitter(startZ, xOffset, engravingDepth);
  let contourStart: { u: number; v: number } | null = null;

  for (const cmd of commands) {
    switch (cmd.type) {
      case 'M':
        emitter.lift();
        emitter.moveTo(cmd.x! * scale, cmd.y! * scale);
        contourStart = { u: cmd.x! * scale, v: cmd.y! * scale };
        break;
      case 'L':
        emitter.lineTo(cmd.x! * scale, cmd.y! * scale);
        break;
      case 'C':
        emitter.cubicTo(
          cmd.x1! * scale, cmd.y1! * scale,
          cmd.x2! * scale, cmd.y2! * scale,
          cmd.x! * scale, cmd.y! * scale,
          tolerance
        );
        break;
      case 'Q':
        emitter.quadTo(
          cmd.x1! * scale, cmd.y1! * scale,
          cmd.x! * scale, cmd.y! * scale,
          tolerance
        );
        break;
      case 'Z':
        if (contourStart) emitter.lineTo(contourStart.u, contourStart.v);
        emitter.lift();
        break;
    }
  }

  emitter.lift();
  return emitter.toolpath;
}

// ============================================================
// BEZIER MATH
// ============================================================

function cubicBezierPoint(
  x0: number, y0: number,
  x1: number, y1: number,
  x2: number, y2: number,
  x3: number, y3: number,
  t: number
): { x: number; y: number } {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const mt3 = mt2 * mt;
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: mt3 * x0 + 3 * mt2 * t * x1 + 3 * mt * t2 * x2 + t3 * x3,
    y: mt3 * y0 + 3 * mt2 * t * y1 + 3 * mt * t2 * y2 + t3 * y3,
  };
}

function quadBezierPoint(
  x0: number, y0: number,
  x1: number, y1: number,
  x2: number, y2: number,
  t: number
): { x: number; y: number } {
  const mt = 1 - t;
  return {
    x: mt * mt * x0 + 2 * mt * t * x1 + t * t * x2,
    y: mt * mt * y0 + 2 * mt * t * y1 + t * t * y2,
  };
}

function bezierLength(
  x0: number, y0: number,
  x1: number, y1: number,
  x2: number, y2: number,
  x3: number, y3: number
): number {
  // Approximate length by sampling
  let len = 0;
  let prev = { x: x0, y: y0 };
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    const pt = cubicBezierPoint(x0, y0, x1, y1, x2, y2, x3, y3, i / steps);
    len += Math.sqrt((pt.x - prev.x) ** 2 + (pt.y - prev.y) ** 2);
    prev = pt;
  }
  return len;
}

function quadBezierLength(
  x0: number, y0: number,
  x1: number, y1: number,
  x2: number, y2: number
): number {
  let len = 0;
  let prev = { x: x0, y: y0 };
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    const pt = quadBezierPoint(x0, y0, x1, y1, x2, y2, i / steps);
    len += Math.sqrt((pt.x - prev.x) ** 2 + (pt.y - prev.y) ** 2);
    prev = pt;
  }
  return len;
}

// ============================================================
// SVG PATH PARSER (minimal)
// ============================================================

interface SvgCommand {
  type: string;
  x?: number;
  y?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
}

function parseSvgPath(d: string): SvgCommand[] {
  const commands: SvgCommand[] = [];
  // Match command letter followed by numbers
  const regex = /([MLHVCSQTAZmlhvcsqtaz])([^MLHVCSQTAZmlhvcsqtaz]*)/g;
  let match;
  let cx = 0, cy = 0;

  while ((match = regex.exec(d)) !== null) {
    const type = match[1];
    const nums = match[2].trim().split(/[\s,]+/).filter(Boolean).map(Number);

    switch (type.toUpperCase()) {
      case 'M':
        cx = type === 'M' ? nums[0] : cx + nums[0];
        cy = type === 'M' ? nums[1] : cy + nums[1];
        commands.push({ type: 'M', x: cx, y: cy });
        break;
      case 'L':
        cx = type === 'L' ? nums[0] : cx + nums[0];
        cy = type === 'L' ? nums[1] : cy + nums[1];
        commands.push({ type: 'L', x: cx, y: cy });
        break;
      case 'H':
        cx = type === 'H' ? nums[0] : cx + nums[0];
        commands.push({ type: 'L', x: cx, y: cy });
        break;
      case 'V':
        cy = type === 'V' ? nums[0] : cy + nums[0];
        commands.push({ type: 'L', x: cx, y: cy });
        break;
      case 'Z':
        commands.push({ type: 'Z' });
        break;
      case 'C':
        for (let i = 0; i < nums.length; i += 6) {
          const abs = type === 'C';
          commands.push({
            type: 'C',
            x1: abs ? nums[i] : cx + nums[i],
            y1: abs ? nums[i + 1] : cy + nums[i + 1],
            x2: abs ? nums[i + 2] : cx + nums[i + 2],
            y2: abs ? nums[i + 3] : cy + nums[i + 3],
            x: abs ? nums[i + 4] : cx + nums[i + 4],
            y: abs ? nums[i + 5] : cy + nums[i + 5],
          });
          cx = abs ? nums[i + 4] : cx + nums[i + 4];
          cy = abs ? nums[i + 5] : cy + nums[i + 5];
        }
        break;
      case 'S':
        // Smooth cubic: approximate by treating the first control point as
        // the current position (loses smooth reflection, keeps the shape)
        for (let i = 0; i < nums.length; i += 4) {
          const abs = type === 'S';
          commands.push({
            type: 'C',
            x1: cx,
            y1: cy,
            x2: abs ? nums[i] : cx + nums[i],
            y2: abs ? nums[i + 1] : cy + nums[i + 1],
            x: abs ? nums[i + 2] : cx + nums[i + 2],
            y: abs ? nums[i + 3] : cy + nums[i + 3],
          });
          cx = abs ? nums[i + 2] : cx + nums[i + 2];
          cy = abs ? nums[i + 3] : cy + nums[i + 3];
        }
        break;
      case 'Q':
        for (let i = 0; i < nums.length; i += 4) {
          const abs = type === 'Q';
          commands.push({
            type: 'Q',
            x1: abs ? nums[i] : cx + nums[i],
            y1: abs ? nums[i + 1] : cy + nums[i + 1],
            x: abs ? nums[i + 2] : cx + nums[i + 2],
            y: abs ? nums[i + 3] : cy + nums[i + 3],
          });
          cx = abs ? nums[i + 2] : cx + nums[i + 2];
          cy = abs ? nums[i + 3] : cy + nums[i + 3];
        }
        break;
      case 'T':
        // Smooth quadratic: control point approximated at current position
        for (let i = 0; i < nums.length; i += 2) {
          const abs = type === 'T';
          commands.push({
            type: 'Q',
            x1: cx,
            y1: cy,
            x: abs ? nums[i] : cx + nums[i],
            y: abs ? nums[i + 1] : cy + nums[i + 1],
          });
          cx = abs ? nums[i] : cx + nums[i];
          cy = abs ? nums[i + 1] : cy + nums[i + 1];
        }
        break;
      case 'A':
        // Arc: approximate with a straight line to the endpoint (7 params each)
        for (let i = 0; i < nums.length; i += 7) {
          const abs = type === 'A';
          cx = abs ? nums[i + 5] : cx + nums[i + 5];
          cy = abs ? nums[i + 6] : cy + nums[i + 6];
          commands.push({ type: 'L', x: cx, y: cy });
        }
        break;
    }
  }

  return commands;
}
