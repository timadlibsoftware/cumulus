import * as k8s from '@kubernetes/client-node';
import type { K8sApi, PodInfo } from './kubernetes.js';

/** Thin @kubernetes/client-node implementation of the executor's K8sApi facade. */
export class ClientNodeK8sApi implements K8sApi {
  private readonly batch: k8s.BatchV1Api;
  private readonly core: k8s.CoreV1Api;
  private readonly attacher: k8s.Attach;

  constructor(kc: k8s.KubeConfig = ClientNodeK8sApi.defaultConfig()) {
    this.batch = kc.makeApiClient(k8s.BatchV1Api);
    this.core = kc.makeApiClient(k8s.CoreV1Api);
    this.attacher = new k8s.Attach(kc);
  }

  static defaultConfig(): k8s.KubeConfig {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    return kc;
  }

  async createJob(namespace: string, job: Record<string, unknown>): Promise<{ uid: string }> {
    const created = await this.batch.createNamespacedJob({ namespace, body: job as k8s.V1Job });
    return { uid: created.metadata?.uid ?? '' };
  }

  async createSecret(namespace: string, secret: Record<string, unknown>): Promise<void> {
    await this.core.createNamespacedSecret({ namespace, body: secret as k8s.V1Secret });
  }

  async setSecretOwner(namespace: string, name: string, owner: { name: string; uid: string }): Promise<void> {
    await this.core.patchNamespacedSecret(
      {
        name,
        namespace,
        body: {
          metadata: {
            ownerReferences: [
              {
                apiVersion: 'batch/v1',
                kind: 'Job',
                name: owner.name,
                uid: owner.uid,
                blockOwnerDeletion: false,
              },
            ],
          },
        },
      },
      k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.MergePatch),
    );
  }

  async deleteSecret(namespace: string, name: string): Promise<void> {
    try {
      await this.core.deleteNamespacedSecret({ name, namespace });
    } catch (err) {
      if ((err as { code?: number }).code !== 404) throw err;
    }
  }

  async deleteSecrets(namespace: string, labelSelector: string): Promise<void> {
    await this.core.deleteCollectionNamespacedSecret({ namespace, labelSelector });
  }

  async deleteJob(namespace: string, name: string): Promise<void> {
    try {
      await this.batch.deleteNamespacedJob({ name, namespace, propagationPolicy: 'Background' });
    } catch (err) {
      if ((err as { code?: number }).code !== 404) throw err;
    }
  }

  async listJobs(namespace: string, labelSelector: string): Promise<string[]> {
    const list = await this.batch.listNamespacedJob({ namespace, labelSelector });
    return list.items.map((j) => j.metadata?.name ?? '').filter(Boolean);
  }

  async listPods(namespace: string, labelSelector: string): Promise<PodInfo[]> {
    const list = await this.core.listNamespacedPod({ namespace, labelSelector });
    return list.items.map((p) => toPodInfo(p));
  }

  async podLogTail(namespace: string, pod: string, container: string): Promise<string> {
    return this.core.readNamespacedPodLog({ name: pod, namespace, container, tailLines: 50 });
  }

  async attach(
    namespace: string,
    pod: string,
    container: string,
    stdin: NodeJS.ReadableStream,
    stdout: NodeJS.WritableStream,
    stderr: NodeJS.WritableStream,
  ) {
    const ws = await this.attacher.attach(namespace, pod, container, stdout, stderr, stdin, false);
    const closed = new Promise<void>((resolve) => {
      ws.on('close', () => resolve());
      ws.on('error', () => resolve());
    });
    return { closed, close: () => ws.close() };
  }
}

export function toPodInfo(p: k8s.V1Pod, container = 'agent'): PodInfo {
  const statuses = p.status?.containerStatuses ?? [];
  const status = statuses.find((c) => c.name === container) ?? statuses[0];
  const state = status?.state;
  const containerState = state?.terminated
    ? 'terminated'
    : state?.running
      ? 'running'
      : state?.waiting
        ? 'waiting'
        : null;
  const created = p.metadata?.creationTimestamp;
  return {
    name: p.metadata?.name ?? '',
    labels: p.metadata?.labels ?? {},
    phase: p.status?.phase ?? 'Unknown',
    containerState,
    exitCode: state?.terminated?.exitCode ?? null,
    reason: state?.terminated?.reason ?? state?.waiting?.reason ?? null,
    imageId: status?.imageID || null,
    createdAt: created ? new Date(created).toISOString() : null,
  };
}
