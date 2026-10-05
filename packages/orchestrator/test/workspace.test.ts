import { describe, expect, it } from 'vitest';
import { assertInsideRoot, branchName, workspaceKey, workspacePath } from '../src/workspace.js';

describe('workspace keys and paths', () => {
  it('§17.2 identifiers unchanged by sanitization keep their key', () => {
    expect(workspaceKey('ABC-123')).toBe('ABC-123');
  });

  it('§4.2 sanitizes disallowed characters and appends a stable hash', () => {
    const key = workspaceKey('AB#123');
    expect(key).toMatch(/^AB_123-[a-z0-9]{13,}$/);
    expect(workspaceKey('AB#123')).toBe(key);
  });

  it('§17.2 distinct identifiers that sanitize to the same text get distinct keys', () => {
    expect(workspaceKey('AB#1')).not.toBe(workspaceKey('AB/1'));
  });

  it('§9.5 keys only contain [A-Za-z0-9._-]', () => {
    expect(workspaceKey('a b/c\\d:é#')).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('§17.2 workspace path is deterministic under the root', () => {
    expect(workspacePath('/ws', 'ABC-1')).toBe('/ws/ABC-1');
  });

  it('§9.5 rejects paths outside the workspace root', () => {
    expect(() => assertInsideRoot('/ws', '/ws/../etc')).toThrow(/outside/);
    expect(() => assertInsideRoot('/ws', '/wsx/a')).toThrow(/outside/);
    expect(() => assertInsideRoot('/ws', '/ws')).toThrow(/outside/);
    expect(() => assertInsideRoot('/ws', '/ws/a')).not.toThrow();
  });

  it('C-10 branch name is cumulus/<workspace key>', () => {
    expect(branchName('ABC-1')).toBe('cumulus/ABC-1');
  });
});
