// Public usage percentages. Dollar limits stay internal; clients only need
// how much of each allowance is used and when it resets.
export interface PublicUsageWindow {
  usedPercent: number;
  pendingPercent: number;
  resetsInMs: number;
}

export interface PublicUsage {
  fiveHour: PublicUsageWindow;
  weekly: PublicUsageWindow;
}

interface WindowLike {
  usedMicro: number;
  limitMicro: number;
  resetsInMs: number;
}

interface SnapshotLike {
  fiveHour: WindowLike;
  weekly: WindowLike;
  pendingMicro: number;
}

export function publicWindow(window: WindowLike, pendingMicro: number): PublicUsageWindow {
  return {
    usedPercent: window.limitMicro > 0 ? window.usedMicro / window.limitMicro * 100 : 100,
    pendingPercent: window.limitMicro > 0 ? pendingMicro / window.limitMicro * 100 : 0,
    resetsInMs: Math.max(0, window.resetsInMs),
  };
}

export function publicUsage(snapshot: SnapshotLike): PublicUsage {
  return {
    fiveHour: publicWindow(snapshot.fiveHour, snapshot.pendingMicro),
    weekly: publicWindow(snapshot.weekly, snapshot.pendingMicro),
  };
}
