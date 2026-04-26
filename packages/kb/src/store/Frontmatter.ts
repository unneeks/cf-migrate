// Frontmatter parser — splits a markdown file into the YAML frontmatter block and the body.
// We parse frontmatter with the `yaml` library so we get the same semantics as pipelines.

import YAML from 'yaml';

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

export interface Frontmatter<T> {
  data: T;
  body: string;
}

export function parseFrontmatter<T>(raw: string): Frontmatter<T> {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return { data: {} as T, body: raw };
  const data = YAML.parse(match[1]) as T;
  return { data, body: match[2] };
}

export function stringifyFrontmatter<T>(data: T, body: string): string {
  const yaml = YAML.stringify(data, { lineWidth: 120, singleQuote: false }).trimEnd();
  return `---\n${yaml}\n---\n\n${body.trimStart()}`;
}
