import { describe, expect, it } from 'vitest';
import { toPodInfo } from '../../src/executor/k8s-client.js';

describe('toPodInfo', () => {
  it('maps a running pod', () => {
    expect(
      toPodInfo({
        metadata: { name: 'p', labels: { a: 'b' }, creationTimestamp: new Date('2026-10-04T00:00:00Z') },
        status: {
          phase: 'Running',
          containerStatuses: [
            {
              name: 'agent',
              image: 'i',
              imageID: 'i@sha256:1',
              ready: true,
              restartCount: 0,
              state: { running: {} },
            },
          ],
        },
      }),
    ).toEqual({
      name: 'p',
      labels: { a: 'b' },
      phase: 'Running',
      containerState: 'running',
      exitCode: null,
      reason: null,
      imageId: 'i@sha256:1',
      createdAt: '2026-10-04T00:00:00.000Z',
    });
  });

  it('maps terminated and waiting states', () => {
    const terminated = toPodInfo({
      status: {
        phase: 'Failed',
        containerStatuses: [
          {
            name: 'agent',
            image: 'i',
            imageID: '',
            ready: false,
            restartCount: 0,
            state: { terminated: { exitCode: 70, reason: 'Error' } },
          },
        ],
      },
    });
    expect(terminated).toMatchObject({
      containerState: 'terminated',
      exitCode: 70,
      reason: 'Error',
      imageId: null,
    });
    const waiting = toPodInfo({
      status: {
        phase: 'Pending',
        containerStatuses: [
          {
            name: 'agent',
            image: 'i',
            imageID: '',
            ready: false,
            restartCount: 0,
            state: { waiting: { reason: 'ImagePullBackOff' } },
          },
        ],
      },
    });
    expect(waiting).toMatchObject({ containerState: 'waiting', reason: 'ImagePullBackOff' });
    expect(toPodInfo({ status: { phase: 'Pending' } })).toMatchObject({ containerState: null });
  });
});
