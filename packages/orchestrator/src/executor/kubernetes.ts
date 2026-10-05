import type { WorkerRow } from '@cumulus/shared';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import type { ServiceConfig } from '../config/config.js';
import { assertInsideRoot } from '../workspace.js';
import type { WorkerExecutor, WorkerExit, WorkerHandle, WorkerSpec } from './types.js';

export const MANAGED_BY = 'app.kubernetes.io/managed-by';
export const LABEL_RUN = 'cumulus.adlib/run-id';
export const LABEL_ISSUE = 'cumulus.adlib/issue';
export const LABEL_INSTANCE = 'cumulus.adlib/instance';
const CONTAINER = 'agent';

/** Normalized pod view used by the executor. */
export interface PodInfo {
  name: string;
  labels: Record<string, string>;
  phase: string;
  containerState: 'waiting' | 'running' | 'terminated' | null;
  exitCode: number | null;
  reason: string | null;
  imageId: string | null;
  createdAt: string | null;
}

/** The few Kubernetes operations the executor needs (facade over @kubernetes/client-node). */
export interface K8sApi {
  createJob(
    namespace: string,
    job: Record<string, unknown> & { metadata: { name: string; labels: Record<string, string> } },
  ): Promise<void>;
  deleteJob(namespace: string, name: string): Promise<void>;
  listJobs(namespace: string, labelSelector: string): Promise<string[]>;
  listPods(namespace: string, labelSelector: string): Promise<PodInfo[]>;
  podLogTail(namespace: string, pod: string, container: string): Promise<string>;
  attach(
    namespace: string,
    pod: string,
    container: string,
    stdin: Readable,
    stdout: Writable,
    stderr: Writable,
  ): Promise<{ closed: Promise<void>; close(): void }>;
}

type WorkerConfig = Pick<
  ServiceConfig['worker'],
  | 'namespace'
  | 'serviceAccount'
  | 'envSecret'
  | 'activeDeadlineSeconds'
  | 'ttlSecondsAfterFinished'
  | 'resources'
> & { image: string | null };

export interface KubernetesExecutorOptions {
  instance: string;
  pollIntervalMs?: number;
  podStartTimeoutMs?: number;
}

/** Kubernetes label value: [A-Za-z0-9._-], max 63, alphanumeric at both ends. */
export function labelValue(s: string): string {
  return s
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 63)
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
}

export function buildJob(spec: WorkerSpec, worker: WorkerConfig, instance: string) {
  if (!worker.image) throw new Error('worker.image is not configured');
  const name = `cumulus-${spec.runId}`.slice(0, 63).replace(/-+$/, '');
  const labels = {
    [MANAGED_BY]: 'cumulus',
    [LABEL_RUN]: labelValue(spec.runId),
    [LABEL_ISSUE]: labelValue(spec.issue.identifier),
    [LABEL_INSTANCE]: labelValue(instance),
  };
  const env: Record<string, string> = {
    ...spec.env,
    CUMULUS_WORKSPACE: spec.workspacePath,
    CUMULUS_WORKSPACE_ROOT: spec.workspaceRoot,
    CUMULUS_HOOK_TIMEOUT_MS: String(spec.hooks.timeoutMs),
  };
  if (spec.hooks.afterCreate) env['CUMULUS_HOOK_AFTER_CREATE'] = spec.hooks.afterCreate;
  if (spec.hooks.beforeRun) env['CUMULUS_HOOK_BEFORE_RUN'] = spec.hooks.beforeRun;
  if (spec.hooks.afterRun) env['CUMULUS_HOOK_AFTER_RUN'] = spec.hooks.afterRun;
  for (const removed of spec.removeEnv) delete env[removed];

  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, labels, annotations: { 'cumulus.adlib/issue-identifier': spec.issue.identifier } },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: worker.activeDeadlineSeconds,
      ttlSecondsAfterFinished: worker.ttlSecondsAfterFinished,
      template: {
        metadata: { labels: { ...labels, 'azure.workload.identity/use': 'true' } },
        spec: {
          restartPolicy: 'Never',
          // Room for after_run when the Job is deleted (§16.5).
          terminationGracePeriodSeconds: Math.ceil(spec.hooks.timeoutMs / 1000) + 30,
          serviceAccountName: worker.serviceAccount,
          automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
          containers: [
            {
              name: CONTAINER,
              image: worker.image,
              args: ['bash', '-lc', spec.command],
              stdin: true,
              stdinOnce: true,
              tty: false,
              env: Object.entries(env).map(([n, value]) => ({ name: n, value })),
              ...(worker.envSecret ? { envFrom: [{ secretRef: { name: worker.envSecret } }] } : {}),
              resources: worker.resources,
              securityContext: {
                runAsNonRoot: true,
                allowPrivilegeEscalation: false,
                capabilities: { drop: ['ALL'] },
              },
            },
          ],
        },
      },
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FATAL_WAITING = new Set([
  'ImagePullBackOff',
  'ErrImagePull',
  'InvalidImageName',
  'CreateContainerConfigError',
  'CreateContainerError',
]);

/** C-3: one Kubernetes Job per worker run; the orchestrator attaches to the container's stdio. */
export class KubernetesExecutor implements WorkerExecutor {
  readonly kind = 'kubernetes';
  private readonly pollMs: number;
  private readonly startTimeoutMs: number;

  constructor(
    private readonly api: K8sApi,
    private readonly worker: WorkerConfig,
    private readonly options: KubernetesExecutorOptions,
  ) {
    this.pollMs = options.pollIntervalMs ?? 1000;
    this.startTimeoutMs = options.podStartTimeoutMs ?? 600_000;
  }

  private async findPod(runId: string): Promise<PodInfo | null> {
    const pods = await this.api.listPods(this.worker.namespace, `${LABEL_RUN}=${labelValue(runId)}`);
    return pods[0] ?? null;
  }

  async start(spec: WorkerSpec): Promise<WorkerHandle> {
    assertInsideRoot(spec.workspaceRoot, spec.workspacePath);
    const job = buildJob(spec, this.worker, this.options.instance);
    const ns = this.worker.namespace;
    await this.api.createJob(ns, job);
    const jobName = job.metadata.name;

    let pod: PodInfo | null;
    try {
      pod = await this.waitForContainer(spec.runId);
    } catch (err) {
      await this.api.deleteJob(ns, jobName).catch(() => {});
      throw err;
    }

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const attachment = await this.api
      .attach(ns, pod.name, CONTAINER, stdin, stdout, stderr)
      .catch(async (err: Error) => {
        await this.api.deleteJob(ns, jobName).catch(() => {});
        throw new Error(`attach to ${pod!.name} failed: ${err.message}`);
      });

    let killed = false;
    const podName = pod.name;
    const exited: Promise<WorkerExit> = attachment.closed.then(async () => {
      stdout.end();
      stderr.end();
      for (let i = 0; i < 20; i++) {
        const current = await this.findPod(spec.runId).catch(() => null);
        if (!current || current.containerState === 'terminated') {
          const code = current?.exitCode ?? null;
          const exit: WorkerExit = { code, reason: killed ? 'killed' : 'exited' };
          if (!killed && code !== 0 && code !== null && current) {
            // C-3: setup/hook failures (exit 70) explain themselves on stderr; keep the tail.
            const logs = await this.api.podLogTail(ns, current.name, CONTAINER).catch(() => '');
            if (logs.trim()) exit.message = logs.trim().slice(-1000);
          }
          return exit;
        }
        await sleep(this.pollMs);
      }
      return {
        code: null,
        reason: killed ? 'killed' : 'exited',
        message: 'attach closed while container still running',
      } as WorkerExit;
    });

    return {
      name: podName,
      stdin,
      stdout,
      stderr,
      exited,
      imageDigest: async () => pod!.imageId,
      kill: async () => {
        killed = true;
        try {
          await this.api.deleteJob(ns, jobName);
        } finally {
          attachment.close();
        }
      },
    };
  }

  private async waitForContainer(runId: string): Promise<PodInfo> {
    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      const pod = await this.findPod(runId);
      if (pod) {
        if (pod.containerState === 'running') return pod;
        if (pod.containerState === 'terminated' || pod.phase === 'Failed' || pod.phase === 'Succeeded') {
          const logs = await this.api.podLogTail(this.worker.namespace, pod.name, CONTAINER).catch(() => '');
          throw new Error(
            `worker container exited with ${pod.exitCode} (${pod.reason ?? pod.phase}) before attach: ${logs.slice(-1000)}`,
          );
        }
        if (pod.reason && FATAL_WAITING.has(pod.reason)) {
          throw new Error(`worker container cannot start: ${pod.reason}`);
        }
      }
      await sleep(this.pollMs);
    }
    throw new Error(`worker pod did not start within ${this.startTimeoutMs}ms`);
  }

  async deleteOrphans(): Promise<string[]> {
    const ns = this.worker.namespace;
    const jobs = await this.api.listJobs(ns, `${MANAGED_BY}=cumulus`);
    await Promise.all(jobs.map((name) => this.api.deleteJob(ns, name)));
    return jobs;
  }

  async listWorkers(): Promise<WorkerRow[]> {
    const pods = await this.api.listPods(this.worker.namespace, `${MANAGED_BY}=cumulus`);
    return pods.map((p) => ({
      name: p.name,
      run_id: p.labels[LABEL_RUN] ?? null,
      issue_identifier: p.labels[LABEL_ISSUE] ?? null,
      phase: p.phase,
      created_at: p.createdAt,
    }));
  }
}
