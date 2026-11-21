import { describe, expect, test } from "bun:test";
import { publicUsage, publicWindow } from "./usage-public";

describe("public usage", () => {
  test("converts spend and reservations to percentages", () => {
    expect(publicWindow({ usedMicro: 4_000_000, limitMicro: 10_000_000, resetsInMs: 1_234 }, 500_000)).toEqual({
      usedPercent: 40,
      pendingPercent: 5,
      resetsInMs: 1_234,
    });
  });

  test("reports a full window when the limit is zero", () => {
    expect(publicWindow({ usedMicro: 0, limitMicro: 0, resetsInMs: -10 }, 0)).toEqual({
      usedPercent: 100,
      pendingPercent: 0,
      resetsInMs: 0,
    });
  });

  test("uses the snapshot's pending total for both windows", () => {
    const window = { usedMicro: 1_000_000, limitMicro: 10_000_000, resetsInMs: 1 };
    expect(publicUsage({ fiveHour: window, weekly: { ...window, limitMicro: 20_000_000 }, pendingMicro: 2_000_000 })).toEqual({
      fiveHour: { usedPercent: 10, pendingPercent: 20, resetsInMs: 1 },
      weekly: { usedPercent: 5, pendingPercent: 10, resetsInMs: 1 },
    });
  });
});
