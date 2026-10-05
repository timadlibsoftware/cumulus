import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WorkflowError,
  loadWorkflow,
  parseWorkflow,
  resolveWorkflowPath,
} from '../../src/config/workflow.js';

async function tempFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cumulus-wf-'));
  const path = join(dir, 'WORKFLOW.md');
  await writeFile(path, content);
  return path;
}

describe('workflow loader', () => {
  it('§5.2 splits YAML front matter from a trimmed prompt body', () => {
    const wf = parseWorkflow('---\ntracker:\n  kind: memory\n---\n\n  Do the work.  \n');
    expect(wf.config).toEqual({ tracker: { kind: 'memory' } });
    expect(wf.promptTemplate).toBe('Do the work.');
  });

  it('§5.2 treats a file without front matter as prompt only with empty config', () => {
    const wf = parseWorkflow('Just a prompt\n');
    expect(wf.config).toEqual({});
    expect(wf.promptTemplate).toBe('Just a prompt');
  });

  it('§17.1 invalid YAML front matter returns workflow_parse_error', () => {
    expect(() => parseWorkflow('---\ntracker: [unclosed\n---\nbody')).toThrow(
      expect.objectContaining({ code: 'workflow_parse_error' }),
    );
  });

  it('§17.1 non-map front matter returns workflow_front_matter_not_a_map', () => {
    expect(() => parseWorkflow('---\n- a\n- b\n---\nbody')).toThrow(
      expect.objectContaining({ code: 'workflow_front_matter_not_a_map' }),
    );
  });

  it('§17.1 missing WORKFLOW.md returns missing_workflow_file', async () => {
    await expect(loadWorkflow('/nonexistent/WORKFLOW.md')).rejects.toBeInstanceOf(WorkflowError);
    await expect(loadWorkflow('/nonexistent/WORKFLOW.md')).rejects.toMatchObject({
      code: 'missing_workflow_file',
    });
  });

  it('§17.1 loads a workflow from disk and records its path', async () => {
    const path = await tempFile('---\npolling:\n  interval_ms: 5\n---\nbody');
    const wf = await loadWorkflow(path);
    expect(wf.path).toBe(path);
    expect(wf.config).toEqual({ polling: { interval_ms: 5 } });
  });

  it('§17.1 explicit runtime path wins over the cwd default', () => {
    expect(resolveWorkflowPath('/x/custom.md', '/cwd')).toBe('/x/custom.md');
  });

  it('§17.1 cwd default is WORKFLOW.md when no explicit path is given', () => {
    expect(resolveWorkflowPath(undefined, '/cwd')).toBe('/cwd/WORKFLOW.md');
  });

  it('§17.1 relative explicit path resolves against cwd', () => {
    expect(resolveWorkflowPath('wf/W.md', '/cwd')).toBe('/cwd/wf/W.md');
  });
});
