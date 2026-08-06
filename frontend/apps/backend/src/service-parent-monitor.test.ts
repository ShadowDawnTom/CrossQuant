import { afterEach, describe, expect, it, vi } from 'vitest';
import { monitorWindowsServiceParent } from './service-parent-monitor.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('Windows service parent monitor', () => {
  it('requests shutdown when the Task Scheduler PowerShell wrapper exits', () => {
    vi.useFakeTimers();
    const onParentExit = vi.fn();
    const isProcessAlive = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    monitorWindowsServiceParent(onParentExit, {
      platform: 'win32',
      parentPid: '4242',
      intervalMs: 10,
      isProcessAlive,
    });

    vi.advanceTimersByTime(10);
    expect(onParentExit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10);
    expect(onParentExit).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(100);
    expect(onParentExit).toHaveBeenCalledOnce();
  });

  it('does nothing outside the packaged Windows service', () => {
    vi.useFakeTimers();
    const onParentExit = vi.fn();
    const isProcessAlive = vi.fn();

    expect(monitorWindowsServiceParent(onParentExit, {
      platform: 'darwin',
      parentPid: '4242',
      isProcessAlive,
    })).toBeUndefined();
    expect(monitorWindowsServiceParent(onParentExit, {
      platform: 'win32',
      parentPid: 'not-a-pid',
      isProcessAlive,
    })).toBeUndefined();
    vi.runAllTimers();
    expect(isProcessAlive).not.toHaveBeenCalled();
    expect(onParentExit).not.toHaveBeenCalled();
  });
});
