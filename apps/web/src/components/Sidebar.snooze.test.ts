import { describe, expect, it } from "vite-plus/test";

import { resolveSnoozePresets, snoozeWakeDescription } from "./Sidebar.snooze";

// Local-time constructor so preset math is timezone-stable in tests.
function localDate(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

describe("resolveSnoozePresets", () => {
  it("offers one hour, three hours, evening, tomorrow, next week, and in a month in the morning", () => {
    // Wednesday 2026-04-08 10:00 local.
    const presets = resolveSnoozePresets(localDate(2026, 4, 8, 10), "locale");
    expect(presets.map((preset) => preset.id)).toEqual([
      "hour",
      "three-hours",
      "evening",
      "tomorrow",
      "next-week",
      "month",
    ]);
    const threeHours = presets.find((preset) => preset.id === "three-hours");
    expect(new Date(threeHours!.snoozedUntil).getHours()).toBe(13);
    const evening = presets.find((preset) => preset.id === "evening");
    expect(new Date(evening!.snoozedUntil).getHours()).toBe(18);
    const tomorrow = presets.find((preset) => preset.id === "tomorrow");
    const tomorrowDate = new Date(tomorrow!.snoozedUntil);
    expect(tomorrowDate.getDate()).toBe(9);
    expect(tomorrowDate.getHours()).toBe(9);
    const nextWeek = presets.find((preset) => preset.id === "next-week");
    const nextWeekDate = new Date(nextWeek!.snoozedUntil);
    expect(nextWeekDate.getDay()).toBe(1);
    expect(nextWeekDate.getDate()).toBe(13);
    const inAMonth = presets.find((preset) => preset.id === "month");
    const inAMonthDate = new Date(inAMonth!.snoozedUntil);
    expect([inAMonthDate.getMonth(), inAMonthDate.getDate(), inAMonthDate.getHours()]).toEqual([
      4, 8, 9,
    ]);
  });

  it("whenLabel complements the label instead of repeating it", () => {
    const presets = resolveSnoozePresets(localDate(2026, 4, 8, 10), "locale");
    for (const preset of presets) {
      // Day words live in the label column; the time column is time-only
      // (plus a weekday for next week, which names a different day).
      expect(preset.whenLabel.toLowerCase()).not.toContain("tomorrow");
    }
    const tomorrow = presets.find((preset) => preset.id === "tomorrow");
    expect(tomorrow!.whenLabel).toMatch(/9/);
    const nextWeek = presets.find((preset) => preset.id === "next-week");
    expect(nextWeek!.whenLabel).toMatch(/Mon/);
    const inAMonth = presets.find((preset) => preset.id === "month");
    // The day of month, in any locale ("May 8 9:00", "8. Mai 9:00").
    expect(inAMonth!.whenLabel).toMatch(/\b8\b/);
  });

  it("drops the evening preset once evening is near or past", () => {
    expect(
      resolveSnoozePresets(localDate(2026, 4, 8, 17, 30), "locale").map((preset) => preset.id),
    ).toEqual(["hour", "three-hours", "tomorrow", "next-week", "month"]);
    expect(
      resolveSnoozePresets(localDate(2026, 4, 8, 21), "locale").map((preset) => preset.id),
    ).toEqual(["hour", "three-hours", "tomorrow", "next-week", "month"]);
  });

  it("puts next week a full week out when today is Monday", () => {
    // Monday 2026-04-06.
    const presets = resolveSnoozePresets(localDate(2026, 4, 6, 10), "locale");
    const nextWeek = new Date(presets.find((preset) => preset.id === "next-week")!.snoozedUntil);
    expect(nextWeek.getDay()).toBe(1);
    expect(nextWeek.getDate()).toBe(13);
  });
  it("wakes in a month on the same day one month out", () => {
    const wakeOf = (now: Date) => {
      const wake = new Date(
        resolveSnoozePresets(now, "locale").find((preset) => preset.id === "month")!.snoozedUntil,
      );
      return [wake.getFullYear(), wake.getMonth() + 1, wake.getDate(), wake.getHours()];
    };
    expect(wakeOf(localDate(2026, 9, 29, 10))).toEqual([2026, 10, 29, 9]);
    // The last day of a month is not folded into "Tomorrow" any more.
    expect(wakeOf(localDate(2026, 9, 30, 22))).toEqual([2026, 10, 30, 9]);
    expect(wakeOf(localDate(2026, 12, 15, 10))).toEqual([2027, 1, 15, 9]);
  });

  it("clamps the one-month wake to the last day of a shorter month", () => {
    const wakeOf = (now: Date) => {
      const wake = new Date(
        resolveSnoozePresets(now, "locale").find((preset) => preset.id === "month")!.snoozedUntil,
      );
      return [wake.getMonth() + 1, wake.getDate()];
    };
    expect(wakeOf(localDate(2026, 1, 31, 10))).toEqual([2, 28]);
    expect(wakeOf(localDate(2028, 1, 31, 10))).toEqual([2, 29]);
    expect(wakeOf(localDate(2026, 3, 31, 10))).toEqual([4, 30]);
  });

  it("formats preset times with the selected clock preference", () => {
    const twelveHour = resolveSnoozePresets(localDate(2026, 4, 8, 10), "12-hour");
    const twentyFourHour = resolveSnoozePresets(localDate(2026, 4, 8, 10), "24-hour");

    expect(twelveHour.find((preset) => preset.id === "evening")!.whenLabel).toMatch(/PM/i);
    expect(twentyFourHour.find((preset) => preset.id === "evening")!.whenLabel).toBe("18:00");
  });
});

describe("snoozeWakeDescription", () => {
  const now = localDate(2026, 4, 8, 10);

  it("uses bare time today, 'tomorrow' next day, weekday within the week", () => {
    expect(
      snoozeWakeDescription(localDate(2026, 4, 8, 18).toISOString(), now, "locale"),
    ).not.toContain("tomorrow");
    expect(snoozeWakeDescription(localDate(2026, 4, 9, 9).toISOString(), now, "locale")).toContain(
      "tomorrow",
    );
    expect(snoozeWakeDescription(localDate(2026, 4, 13, 9).toISOString(), now, "locale")).toMatch(
      /Mon/,
    );
  });

  it("formats wake descriptions with the selected clock preference", () => {
    expect(snoozeWakeDescription(localDate(2026, 4, 8, 18).toISOString(), now, "12-hour")).toMatch(
      /PM/i,
    );
    expect(snoozeWakeDescription(localDate(2026, 4, 8, 18).toISOString(), now, "24-hour")).toBe(
      "18:00",
    );
  });
});
