import { describe, expect, it } from 'vitest';
import { PromptError, DEFAULT_PROMPT, continuationPrompt, renderPrompt } from '../src/prompt.js';
import { makeIssue } from './fixtures/issues.js';

const issue = makeIssue({ id: '7', title: 'Fix it', labels: ['cumulus', 'infra'] });

describe('prompt rendering', () => {
  it('§17.1 renders issue fields and attempt', async () => {
    const out = await renderPrompt('{{ issue.identifier }}: {{ issue.title }} attempt={{ attempt }}', {
      issue,
      attempt: 2,
    });
    expect(out).toBe('AB#7: Fix it attempt=2');
  });

  it('§12.2 preserves nested lists so templates can iterate', async () => {
    const out = await renderPrompt('{% for l in issue.labels %}[{{ l }}]{% endfor %}', {
      issue,
      attempt: null,
    });
    expect(out).toBe('[cumulus][infra]');
  });

  it('§5.4 attempt is null on the first run', async () => {
    const out = await renderPrompt('{% if attempt %}retry{% else %}first{% endif %}', {
      issue,
      attempt: null,
    });
    expect(out).toBe('first');
  });

  it('§17.1 fails on unknown variables (strict mode)', async () => {
    await expect(renderPrompt('{{ nope }}', { issue, attempt: null })).rejects.toMatchObject({
      code: 'template_render_error',
    });
  });

  it('§5.5 fails on unknown filters', async () => {
    await expect(renderPrompt('{{ issue.title | bogus }}', { issue, attempt: null })).rejects.toBeInstanceOf(
      PromptError,
    );
  });

  it('§5.5 reports template_parse_error for invalid syntax', async () => {
    await expect(renderPrompt('{% if %}', { issue, attempt: null })).rejects.toMatchObject({
      code: 'template_parse_error',
    });
  });

  it('§5.4 uses the minimal default prompt when the body is empty', async () => {
    expect(await renderPrompt('', { issue, attempt: null })).toBe(DEFAULT_PROMPT);
  });

  it('C-10 exposes cumulus.branch to templates', async () => {
    const out = await renderPrompt('{{ cumulus.branch }}', {
      issue,
      attempt: null,
      cumulus: { branch: 'cumulus/AB_7-x' },
    });
    expect(out).toBe('cumulus/AB_7-x');
  });

  it('§7.1 continuation guidance does not resend the task prompt', () => {
    const text = continuationPrompt(issue, 3, 20);
    expect(text).toContain('AB#7');
    expect(text).toContain('turn 3 of 20');
  });
});
