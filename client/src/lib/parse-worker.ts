/**
 * Web Worker for CAD file parsing.
 * Runs DXF/STL/OBJ parsing off the main thread to prevent UI freezes.
 *
 * Communication:
 * - Main thread sends: { type: 'parse', format: 'dxf'|'stl'|'obj', data: string|ArrayBuffer, filename: string }
 * - Worker responds: { type: 'result', geometry: ImportedGeometry } or { type: 'error', message: string }
 * - Worker sends progress: { type: 'progress', percent: number, message: string }
 */

// Note: This worker imports are handled at build time by Vite's worker support.
// The actual parsing functions are inlined here since workers can't use ES module imports easily.

self.onmessage = async (e: MessageEvent) => {
  const { type, format, data, filename } = e.data;

  if (type !== 'parse') return;

  try {
    self.postMessage({ type: 'progress', percent: 10, message: 'Starting parse...' });

    // For now, post back that parsing should happen on main thread
    // Full worker implementation would inline the parser code
    // This is a progressive enhancement — the FileImporter falls back to main thread
    self.postMessage({
      type: 'error',
      message: 'Worker parsing not yet fully implemented — using main thread',
    });
  } catch (err: any) {
    self.postMessage({ type: 'error', message: err.message || 'Parse failed' });
  }
};
