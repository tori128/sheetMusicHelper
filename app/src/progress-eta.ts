interface ProgressObservation {
  key: string;
  completed: number;
  total: number;
  observedAtMs: number;
}

const RATE_SMOOTHING_FACTOR = 0.3;
const MIN_OBSERVATION_WINDOW_MS = 3_000;

export class ProgressEtaEstimator {
  #key: string | null = null;
  #startedAtMs = 0;
  #baselineCompleted = 0;
  #previous: ProgressObservation | null = null;
  #smoothedMsPerUnit: number | null = null;

  start(key: string, observedAtMs: number, completed = 0): void {
    if (
      this.#key === key ||
      !Number.isFinite(observedAtMs) ||
      !Number.isFinite(completed)
    ) {
      return;
    }
    this.#key = key;
    this.#startedAtMs = observedAtMs;
    this.#baselineCompleted = Math.max(0, completed);
    this.#previous = null;
    this.#smoothedMsPerUnit = null;
  }

  update(observation: ProgressObservation): number | null {
    const { key, completed, total, observedAtMs } = observation;
    if (
      !Number.isFinite(completed) ||
      !Number.isFinite(total) ||
      !Number.isFinite(observedAtMs) ||
      completed < 0 ||
      total <= 0 ||
      completed >= total
    ) {
      this.reset();
      return null;
    }

    if (this.#key !== key) {
      this.start(key, observedAtMs, completed);
    }

    const previous = this.#previous;
    if (previous !== null && (
      completed < previous.completed ||
      total !== previous.total
    )) {
      this.reset();
      this.start(key, observedAtMs, completed);
      this.#previous = observation;
      return null;
    }

    const stageElapsedMs = observedAtMs - this.#startedAtMs;
    const stageCompleted = completed - this.#baselineCompleted;
    if (previous !== null) {
      const completedDelta = completed - previous.completed;
      const elapsedDeltaMs = observedAtMs - previous.observedAtMs;
      if (completedDelta > 0 && elapsedDeltaMs > 0) {
        const intervalMsPerUnit = elapsedDeltaMs / completedDelta;
        const cumulativeMsPerUnit =
          stageCompleted > 0 ? stageElapsedMs / stageCompleted : null;
        const initialMsPerUnit = cumulativeMsPerUnit ?? intervalMsPerUnit;
        this.#smoothedMsPerUnit =
          this.#smoothedMsPerUnit === null
            ? initialMsPerUnit
            : this.#smoothedMsPerUnit * (1 - RATE_SMOOTHING_FACTOR) +
              intervalMsPerUnit * RATE_SMOOTHING_FACTOR;
      }
    }
    this.#previous = observation;

    if (
      stageElapsedMs < MIN_OBSERVATION_WINDOW_MS ||
      stageCompleted <= 0
    ) {
      return null;
    }
    const cumulativeMsPerUnit = stageElapsedMs / stageCompleted;
    const effectiveMsPerUnit = Math.max(
      cumulativeMsPerUnit,
      this.#smoothedMsPerUnit ?? cumulativeMsPerUnit,
    );
    return Math.max(
      1,
      Math.ceil(((total - completed) * effectiveMsPerUnit) / 1000),
    );
  }

  reset(): void {
    this.#key = null;
    this.#startedAtMs = 0;
    this.#baselineCompleted = 0;
    this.#previous = null;
    this.#smoothedMsPerUnit = null;
  }
}

export function formatEstimatedRemainingTime(seconds: number): string {
  const normalized = Math.max(1, Math.ceil(seconds));
  if (normalized < 60) {
    return `約${Math.ceil(normalized / 5) * 5}秒`;
  }
  const minutes = Math.floor(normalized / 60);
  const remainingSeconds = Math.ceil((normalized % 60) / 10) * 10;
  if (remainingSeconds === 60) {
    return `約${minutes + 1}分`;
  }
  return remainingSeconds === 0
    ? `約${minutes}分`
    : `約${minutes}分${remainingSeconds}秒`;
}
