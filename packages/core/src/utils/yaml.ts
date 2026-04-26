/**
 * YAML helpers. We expose `parseYaml` (returns the parsed JS value), `parseYamlDocument`
 * (returns the underlying yaml.Document so we can look up node positions for decorations),
 * and `positionOfNode` (maps a YAML node to a 1-indexed line range).
 */
import YAML, { Document, LineCounter, Pair, Scalar, YAMLMap, YAMLSeq, isMap, isSeq, isPair, isScalar } from 'yaml';

export interface LineRange {
  lineStart: number;
  lineEnd: number;
}

export function parseYaml<T = unknown>(source: string): T {
  return YAML.parse(source) as T;
}

export interface ParsedPipeline {
  doc: Document.Parsed;
  lineCounter: LineCounter;
}

export function parsePipeline(source: string): ParsedPipeline {
  const lineCounter = new LineCounter();
  const doc = YAML.parseDocument(source, { keepSourceTokens: true, lineCounter });
  return { doc, lineCounter };
}

export function stringify(value: unknown): string {
  return YAML.stringify(value, { lineWidth: 120, singleQuote: false });
}

/**
 * Return 1-indexed line range for a node. If positions are unavailable (e.g. node was
 * synthesised rather than parsed), returns { lineStart: 1, lineEnd: 1 }.
 */
export function positionOfNode(node: unknown, lineCounter: LineCounter): LineRange {
  if (!node || typeof node !== 'object') return { lineStart: 1, lineEnd: 1 };
  const anyNode = node as { range?: [number, number, number] };
  if (!anyNode.range) return { lineStart: 1, lineEnd: 1 };
  const [start, , end] = anyNode.range;
  const s = lineCounter.linePos(start).line;
  const e = lineCounter.linePos(end).line;
  return { lineStart: s, lineEnd: Math.max(s, e) };
}

/**
 * Walk the document invoking `visit` on every pair (path included). Used by construct
 * detectors to find keys of interest without hand-rolling traversal.
 */
export function walkPairs(doc: Document.Parsed, visit: (pair: Pair, path: string[]) => void): void {
  const root = doc.contents;
  if (!root) return;
  walkNode(root, [], visit);
}

function walkNode(node: unknown, path: string[], visit: (pair: Pair, path: string[]) => void): void {
  if (isMap(node)) {
    for (const item of node.items) {
      if (isPair(item)) {
        const keyName = scalarKey(item.key);
        visit(item, path);
        walkNode(item.value, keyName ? [...path, keyName] : path, visit);
      }
    }
  } else if (isSeq(node)) {
    node.items.forEach((child, i) => walkNode(child, [...path, `[${i}]`], visit));
  }
}

export function scalarKey(k: unknown): string | undefined {
  if (isScalar(k)) {
    const v = (k as Scalar).value;
    return typeof v === 'string' ? v : undefined;
  }
  if (typeof k === 'string') return k;
  return undefined;
}

export function asMap(node: unknown): YAMLMap | undefined {
  return isMap(node) ? node : undefined;
}

export function asSeq(node: unknown): YAMLSeq | undefined {
  return isSeq(node) ? node : undefined;
}
