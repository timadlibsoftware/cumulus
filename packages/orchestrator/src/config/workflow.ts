import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

export type WorkflowErrorCode =
  'missing_workflow_file' | 'workflow_parse_error' | 'workflow_front_matter_not_a_map';

export class WorkflowError extends Error {
  constructor(
    readonly code: WorkflowErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowError';
  }
}

export interface WorkflowDefinition {
  config: Record<string, unknown>;
  promptTemplate: string;
}

export interface LoadedWorkflow extends WorkflowDefinition {
  path: string;
}

/** §5.1: explicit runtime path, otherwise `WORKFLOW.md` in the cwd. */
export function resolveWorkflowPath(explicit: string | undefined, cwd: string): string {
  return resolve(cwd, explicit ?? 'WORKFLOW.md');
}

/** §5.2: optional `---` delimited YAML front matter followed by the prompt body. */
export function parseWorkflow(text: string): WorkflowDefinition {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    return { config: {}, promptTemplate: text.trim() };
  }
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end === -1) {
    throw new WorkflowError('workflow_parse_error', 'front matter is not closed with ---');
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(lines.slice(1, end).join('\n'));
  } catch (err) {
    throw new WorkflowError('workflow_parse_error', `invalid YAML front matter: ${(err as Error).message}`);
  }
  if (parsed === null || parsed === undefined) parsed = {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WorkflowError('workflow_front_matter_not_a_map', 'front matter must be a YAML map');
  }
  return {
    config: parsed as Record<string, unknown>,
    promptTemplate: lines
      .slice(end + 1)
      .join('\n')
      .trim(),
  };
}

export async function loadWorkflow(path: string): Promise<LoadedWorkflow> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new WorkflowError('missing_workflow_file', `cannot read ${path}: ${(err as Error).message}`);
  }
  return { path, ...parseWorkflow(text) };
}
