import { describe, expect, it } from 'vitest';
import * as k8s from '@kubernetes/client-node';
import { ClientNodeK8sApi } from '../../src/executor/k8s-client.js';

/** Read-only list calls against a real cluster. Enable with CUMULUS_LIVE_K8S_CONTEXT=<context>. */
const context = process.env['CUMULUS_LIVE_K8S_CONTEXT'];

describe.skipIf(!context)('kubernetes facade live (read-only)', () => {
  it('lists cumulus jobs and pods in the agents namespace', async () => {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    kc.setCurrentContext(context!);
    const api = new ClientNodeK8sApi(kc);
    expect(Array.isArray(await api.listJobs('agents', 'app.kubernetes.io/managed-by=cumulus'))).toBe(true);
    expect(Array.isArray(await api.listPods('agents', 'app.kubernetes.io/managed-by=cumulus'))).toBe(true);
  }, 30_000);
});
