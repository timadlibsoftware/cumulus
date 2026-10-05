import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { resolveConfig } from '../../src/config/config.js';
import { parseWorkflow } from '../../src/config/workflow.js';
import { renderPrompt } from '../../src/prompt.js';
import { createTracker } from '../../src/tracker/registry.js';
import { makeIssue } from '../fixtures/issues.js';

/** The WORKFLOW.md deployed by the chart must load, validate and render with this orchestrator. */
describe('chart default WORKFLOW.md', () => {
  it('parses, validates against the ADO adapter and renders strictly', async () => {
    const values = parse(await readFile(resolve(__dirname, '../../../../chart/values.yaml'), 'utf8')) as {
      workflow: string;
    };
    const wf = parseWorkflow(values.workflow);
    const config = resolveConfig(wf.config, {
      workflowDir: '/config',
      env: { CUMULUS_WORKER_IMAGE: 'img:1' },
    });
    expect(config.tracker.activeStates).toEqual(['Backlog', 'Dev', 'Test']);
    expect(config.tracker.terminalStates).toEqual(['Done', 'Closed']);
    expect(config.runner.kind).toBe('opencode');
    expect(JSON.parse(config.worker.env['OPENCODE_CONFIG_CONTENT']!)).toMatchObject({
      model: 'litellm/claude-sonnet-5',
    });
    expect(() => createTracker(config.tracker, { env: {} })).not.toThrow();
    for (const attempt of [null, 2]) {
      const prompt = await renderPrompt(wf.promptTemplate, {
        issue: makeIssue({ id: '123', identifier: 'AB#123', description: 'Do it' }),
        attempt,
        cumulus: { branch: 'cumulus/AB_123-abc', workspace_key: 'AB_123-abc', run_id: 'r' },
      });
      expect(prompt).toContain('cumulus/AB_123-abc');
      expect(prompt).toContain('azure_devops_move_card');
    }
  });
});
