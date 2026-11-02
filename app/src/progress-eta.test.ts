import { describe, expect, it } from "vitest";
import {
  formatEstimatedRemainingTime,
  ProgressEtaEstimator,
} from "./progress-eta";

describe("ProgressEtaEstimator", () => {
  it("waits for a stable observation window before estimating", () => {
    const estimator = new ProgressEtaEstimator();
    estimator.start("job-1", 0);

    expect(
      estimator.update({
        key: "job-1",
        completed: 10,
        total: 100,
        observedAtMs: 1_000,
      }),
    ).toBeNull();
    expect(
      estimator.update({
        key: "job-1",
        completed: 20,
        total: 100,
        observedAtMs: 2_000,
      }),
    ).toBeNull();
    expect(
      estimator.update({
        key: "job-1",
        completed: 30,
        total: 100,
        observedAtMs: 3_000,
      }),
    ).toBe(7);
  });

  it("resets when a new stage starts or progress moves backwards", () => {
    const estimator = new ProgressEtaEstimator();
    estimator.start("transcription", 0);
    estimator.update({
      key: "transcription",
      completed: 10,
      total: 100,
      observedAtMs: 0,
    });
    expect(
      estimator.update({
        key: "transcription",
        completed: 20,
        total: 100,
        observedAtMs: 10_000,
      }),
    ).toBe(40);
    expect(
      estimator.update({
        key: "chords",
        completed: 5,
        total: 100,
        observedAtMs: 11_000,
      }),
    ).toBeNull();
    expect(
      estimator.update({
        key: "chords",
        completed: 3,
        total: 100,
        observedAtMs: 12_000,
      }),
    ).toBeNull();
  });
});

describe("formatEstimatedRemainingTime", () => {
  it("uses readable rounded units", () => {
    expect(formatEstimatedRemainingTime(1)).toBe("約5秒");
    expect(formatEstimatedRemainingTime(58)).toBe("約60秒");
    expect(formatEstimatedRemainingTime(80)).toBe("約1分20秒");
    expect(formatEstimatedRemainingTime(119)).toBe("約2分");
  });
});
