export type ServiceParentMonitorOptions = {
  platform?: NodeJS.Platform;
  parentPid?: string;
  intervalMs?: number;
  isProcessAlive?: (pid: number) => boolean;
};

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Task Scheduler stops the PowerShell action without terminating the Node child.
 * Watch the service wrapper so its disappearance can trigger the backend's normal,
 * order-safe shutdown path instead of leaving an orphaned trading process behind.
 */
export function monitorWindowsServiceParent(
  onParentExit: () => void,
  options: ServiceParentMonitorOptions = {},
): (() => void) | undefined {
  const platform = options.platform ?? process.platform;
  const parentPidText = options.parentPid ?? process.env.GCT_WINDOWS_SERVICE_PARENT_PID;
  if (platform !== 'win32' || !parentPidText) return undefined;

  const parentPid = Number(parentPidText);
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0 || parentPid === process.pid) {
    return undefined;
  }

  const checkParent = options.isProcessAlive ?? isProcessAlive;
  const timer = setInterval(() => {
    if (checkParent(parentPid)) return;
    clearInterval(timer);
    onParentExit();
  }, options.intervalMs ?? 250);
  timer.unref();
  return () => clearInterval(timer);
}
