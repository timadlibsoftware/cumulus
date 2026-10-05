import type { Issue } from '@cumulus/shared';
import { Liquid } from 'liquidjs';

export class PromptError extends Error {
  constructor(
    readonly code: 'template_parse_error' | 'template_render_error',
    message: string,
  ) {
    super(message);
    this.name = 'PromptError';
  }
}

/** §5.4 fallback when the workflow body is empty. */
export const DEFAULT_PROMPT = 'You are working on an issue from the configured tracker.';

export interface PromptInput {
  issue: Issue;
  attempt: number | null;
  /** Cumulus template variables (C-10). */
  cumulus?: Record<string, unknown>;
}

const engine = new Liquid({ strictVariables: true, strictFilters: true });

export async function renderPrompt(template: string, input: PromptInput): Promise<string> {
  if (template.trim() === '') return DEFAULT_PROMPT;
  let parsed;
  try {
    parsed = engine.parse(template);
  } catch (err) {
    throw new PromptError('template_parse_error', (err as Error).message);
  }
  try {
    return await engine.render(parsed, {
      issue: input.issue,
      attempt: input.attempt,
      cumulus: input.cumulus ?? {},
    });
  } catch (err) {
    throw new PromptError('template_render_error', (err as Error).message);
  }
}

/** §7.1: continuation turns send guidance only; the task is already in the thread. */
export function continuationPrompt(issue: Issue, turn: number, maxTurns: number): string {
  return [
    `Continue working on ${issue.identifier}: ${issue.title} (turn ${turn} of ${maxTurns}).`,
    `The issue is still in an active state (${issue.state}).`,
    'Pick up where you left off. When the work is complete and pull requests are open, hand off as instructed.',
  ].join(' ');
}
