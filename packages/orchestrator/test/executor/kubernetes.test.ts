import { PassThrough, type Readable, type Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { KubernetesExecutor, buildJob, type K8sApi, type PodInfo } from '../../src/executor/kubernetes.js';
import type { WorkerSpec } from '../../src/executor/types.js';
import { makeIssue } from '../fixtures/issues.js';

const worker = {
  namespace: 'agents',
  image: 'acr.io/agents/cumulus-worker:42',
  serviceAccount: 'cumulus-agent',
  envSecret: 'cumulus-agent-env',
  activeDeadlineSeconds: 14400,
  ttlSecondsAfterFinished: 3600,
  resources: { requests: { cpu: '1' } },
};

function spec(overrides: Partial<WorkerSpec> = {}): WorkerSpec {
  return {
    runId: '0192f3a4-aaaa-bbbb-cccc-1234567890ab',
    issue: makeIssue({ id: '123', identifier: 'AB#123' }),
    workspaceRoot: '/tmp/symphony_workspaces',
    workspacePath: '/tmp/symphony_workspaces/AB_123-abc',
    command: 'opencode acp',
    env: { CUMULUS_RUN_ID: 'r', CUMULUS_RUN_TOKEN: 'tok' },
    removeEnv: [],
    hooks: { afterCreate: 'echo hi', beforeRun: null, afterRun: 'echo bye', timeoutMs: 60000 },
    ...overrides,
  };
}

class FakeK8s implements K8sApi {
  jobs = new Map<string, { labels: Record<string, string>; body: unknown }>();
  pods = new Map<string, PodInfo>();
  deleted: string[] = [];
  attached: { pod: string; stdin: Readable; stdout: Writable; stderr: Writable; close: () => void }[] = [];
  logs = 'hook failed: before_run exited 1';
  podForJob: (name: string, labels: Record<string, string>) => PodInfo | null = (name, labels) => ({
    name: `${name}-xyz`,
    labels,
    phase: 'Running',
    containerState: 'running',
    exitCode: null,
    reason: null,
    imageId: 'acr.io/agents/cumulus-worker@sha256:abc',
    createdAt: '2026-10-04T00:00:00Z',
  });

  async createJob(_ns: string, job: { metadata: { name: string; labels: Record<string, string> } }) {
    this.jobs.set(job.metadata.name, { labels: job.metadata.labels, body: job });
    const pod = this.podForJob(job.metadata.name, job.metadata.labels);
    if (pod) this.pods.set(pod.name, pod);
  }
  async deleteJob(_ns: string, name: string) {
    this.deleted.push(name);
    this.jobs.delete(name);
    for (const [k, p] of this.pods)
      if (k.startsWith(name))
        this.pods.set(k, { ...p, phase: 'Failed', containerState: 'terminated', exitCode: 143 });
  }
  async listJobs(_ns: string, selector: string) {
    const [k, v] = selector.split('=');
    return [...this.jobs.entries()].filter(([, j]) => j.labels[k!] === v).map(([name]) => name);
  }
  async listPods(_ns: string, selector: string) {
    const [k, v] = selector.split('=');
    return [...this.pods.values()].filter((p) => p.labels[k!] === v);
  }
  async podLogTail() {
    return this.logs;
  }
  async attach(_ns: string, pod: string, _c: string, stdin: Readable, stdout: Writable, stderr: Writable) {
    let close!: () => void;
    const closed = new Promise<void>((r) => (close = r));
    this.attached.push({ pod, stdin, stdout, stderr, close });
    return { closed, close };
  }
}

const opts = { instance: 'inst-1', pollIntervalMs: 5, podStartTimeoutMs: 200 };

describe('KubernetesExecutor (C-3)', () => {
  it('builds a single-attempt Job with stdin attach, identity and labels', () => {
    const job = buildJob(spec(), worker, 'inst-1') as any;
    expect(job.metadata.name).toBe('cumulus-0192f3a4-aaaa-bbbb-cccc-1234567890ab');
    expect(job.metadata.labels).toMatchObject({
      'app.kubernetes.io/managed-by': 'cumulus',
      'cumulus.adlib/run-id': '0192f3a4-aaaa-bbbb-cccc-1234567890ab',
      'cumulus.adlib/issue': 'AB_123',
      'cumulus.adlib/instance': 'inst-1',
    });
    expect(job.spec).toMatchObject({
      backoffLimit: 0,
      activeDeadlineSeconds: 14400,
      ttlSecondsAfterFinished: 3600,
    });
    const pod = job.spec.template;
    expect(pod.metadata.labels).toMatchObject({
      'azure.workload.identity/use': 'true',
      'app.kubernetes.io/managed-by': 'cumulus',
    });
    expect(pod.spec).toMatchObject({
      restartPolicy: 'Never',
      serviceAccountName: 'cumulus-agent',
      automountServiceAccountToken: false,
    });
    const c = pod.spec.containers[0];
    expect(c).toMatchObject({
      name: 'agent',
      image: worker.image,
      stdin: true,
      stdinOnce: true,
      tty: false,
      args: ['bash', '-lc', 'opencode acp'],
    });
    expect(c.envFrom).toEqual([{ secretRef: { name: 'cumulus-agent-env' } }]);
    const env = Object.fromEntries(c.env.map((e: { name: string; value: string }) => [e.name, e.value]));
    expect(env).toMatchObject({
      CUMULUS_WORKSPACE: '/tmp/symphony_workspaces/AB_123-abc',
      CUMULUS_WORKSPACE_ROOT: '/tmp/symphony_workspaces',
      CUMULUS_HOOK_AFTER_CREATE: 'echo hi',
      CUMULUS_HOOK_AFTER_RUN: 'echo bye',
      CUMULUS_HOOK_TIMEOUT_MS: '60000',
      CUMULUS_RUN_TOKEN: 'tok',
    });
    expect(env).not.toHaveProperty('CUMULUS_HOOK_BEFORE_RUN');
    expect(c.securityContext).toMatchObject({ runAsNonRoot: true, allowPrivilegeEscalation: false });
    expect(c.resources).toEqual({ requests: { cpu: '1' } });
  });

  it('§9.5 rejects out-of-root workspace paths before creating anything', async () => {
    const k8s = new FakeK8s();
    const ex = new KubernetesExecutor(k8s, worker, opts);
    await expect(ex.start(spec({ workspacePath: '/etc/x' }))).rejects.toThrow(/outside/);
    expect(k8s.jobs.size).toBe(0);
  });

  it('creates the Job, waits for the container, attaches stdio and reports the image digest', async () => {
    const k8s = new FakeK8s();
    const ex = new KubernetesExecutor(k8s, worker, opts);
    const h = await ex.start(spec());
    expect(h.name).toBe('cumulus-0192f3a4-aaaa-bbbb-cccc-1234567890ab-xyz');
    expect(k8s.attached).toHaveLength(1);
    expect(await h.imageDigest()).toBe('acr.io/agents/cumulus-worker@sha256:abc');
    // Bytes flow both ways.
    const a = k8s.attached[0]!;
    let received = '';
    a.stdin.on('data', (d: Buffer) => (received += d.toString()));
    h.stdin.write('ping\n');
    let out = '';
    h.stdout.on('data', (d: Buffer) => (out += d.toString()));
    a.stdout.write('pong\n');
    await new Promise((r) => setTimeout(r, 5));
    expect(received).toBe('ping\n');
    expect(out).toBe('pong\n');
  });

  it('reports the container exit code when the attach stream closes', async () => {
    const k8s = new FakeK8s();
    const ex = new KubernetesExecutor(k8s, worker, opts);
    const h = await ex.start(spec());
    const pod = [...k8s.pods.values()][0]!;
    k8s.pods.set(pod.name, { ...pod, phase: 'Succeeded', containerState: 'terminated', exitCode: 0 });
    k8s.attached[0]!.close();
    expect(await h.exited).toEqual({ code: 0, reason: 'exited' });
  });

  it('fails the start when the container terminates before attach, with the log tail', async () => {
    const k8s = new FakeK8s();
    k8s.podForJob = (name, labels) => ({
      name: `${name}-p`,
      labels,
      phase: 'Failed',
      containerState: 'terminated',
      exitCode: 70,
      reason: 'Error',
      imageId: null,
      createdAt: null,
    });
    const ex = new KubernetesExecutor(k8s, worker, opts);
    await expect(ex.start(spec())).rejects.toThrow(/exited with 70.*before_run exited 1/s);
    expect(k8s.deleted).toHaveLength(1);
  });

  it('fails the start on image pull errors', async () => {
    const k8s = new FakeK8s();
    k8s.podForJob = (name, labels) => ({
      name: `${name}-p`,
      labels,
      phase: 'Pending',
      containerState: 'waiting',
      exitCode: null,
      reason: 'ImagePullBackOff',
      imageId: null,
      createdAt: null,
    });
    const ex = new KubernetesExecutor(k8s, worker, opts);
    await expect(ex.start(spec())).rejects.toThrow(/ImagePullBackOff/);
    expect(k8s.deleted).toHaveLength(1);
  });

  it('times out when the pod never starts and deletes the Job', async () => {
    const k8s = new FakeK8s();
    k8s.podForJob = () => null;
    const ex = new KubernetesExecutor(k8s, worker, opts);
    await expect(ex.start(spec())).rejects.toThrow(/did not start/);
    expect(k8s.deleted).toHaveLength(1);
  });

  it('kill deletes the Job and resolves exited as killed', async () => {
    const k8s = new FakeK8s();
    const ex = new KubernetesExecutor(k8s, worker, opts);
    const h = await ex.start(spec());
    await h.kill();
    k8s.attached[0]!.close();
    expect(await h.exited).toMatchObject({ reason: 'killed' });
    expect(k8s.deleted).toEqual(['cumulus-0192f3a4-aaaa-bbbb-cccc-1234567890ab']);
  });

  it('C-4 deletes every Job managed by cumulus as an orphan at startup', async () => {
    const k8s = new FakeK8s();
    k8s.jobs.set('cumulus-old-1', { labels: { 'app.kubernetes.io/managed-by': 'cumulus' }, body: {} });
    k8s.jobs.set('cumulus-old-2', { labels: { 'app.kubernetes.io/managed-by': 'cumulus' }, body: {} });
    k8s.jobs.set('other', { labels: { app: 'x' }, body: {} });
    const ex = new KubernetesExecutor(k8s, worker, opts);
    expect((await ex.deleteOrphans()).sort()).toEqual(['cumulus-old-1', 'cumulus-old-2']);
    expect(k8s.jobs.has('other')).toBe(true);
  });

  it('lists worker pods', async () => {
    const k8s = new FakeK8s();
    const ex = new KubernetesExecutor(k8s, worker, opts);
    await ex.start(spec());
    expect(await ex.listWorkers()).toEqual([
      {
        name: 'cumulus-0192f3a4-aaaa-bbbb-cccc-1234567890ab-xyz',
        run_id: '0192f3a4-aaaa-bbbb-cccc-1234567890ab',
        issue_identifier: 'AB_123',
        phase: 'Running',
        created_at: '2026-10-04T00:00:00Z',
      },
    ]);
  });
});
