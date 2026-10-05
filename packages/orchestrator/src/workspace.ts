import { createHash } from 'node:crypto';
import { join, relative, resolve, isAbsolute } from 'node:path';

/** §4.2 / §9.5: sanitized, collision-resistant workspace key. */
export function workspaceKey(identifier: string): string {
  const sanitized = identifier.replace(/[^A-Za-z0-9._-]/g, '_');
  if (sanitized === identifier) return identifier;
  // 16 hex chars = 64 bits of entropy.
  const hash = createHash('sha256').update(identifier).digest('hex').slice(0, 16);
  return `${sanitized}-${hash}`;
}

export function workspacePath(root: string, key: string): string {
  const path = join(root, key);
  assertInsideRoot(root, path);
  return path;
}

/** §9.5 invariant 2: the workspace must be a directory strictly inside the root. */
export function assertInsideRoot(root: string, path: string): void {
  const rel = relative(resolve(root), resolve(path));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`workspace path ${path} is outside workspace root ${root}`);
  }
}

/** C-10: fixed per-issue branch name. */
export function branchName(key: string): string {
  return `cumulus/${key}`;
}
