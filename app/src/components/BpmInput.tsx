import { useEffect, useRef, useState } from "react";

interface BpmInputProps {
  value: number;
  disabled?: boolean;
  onCommit: (value: number) => void;
}

export const MIN_BPM = 20;
export const MAX_BPM = 300;

function formatBpm(value: number): string {
  return String(value);
}

export function BpmInput({
  value,
  disabled = false,
  onCommit,
}: BpmInputProps) {
  const [draft, setDraft] = useState(() => formatBpm(value));
  const focusedRef = useRef(false);
  const skipBlurRef = useRef(false);
  const parsed = Number(draft);
  const valid =
    draft.trim() !== "" &&
    Number.isFinite(parsed) &&
    parsed >= MIN_BPM &&
    parsed <= MAX_BPM;

  useEffect(() => {
    if (!focusedRef.current) {
      setDraft(formatBpm(value));
    }
  }, [value]);

  function commit(rawValue: string) {
    if (disabled) {
      setDraft(formatBpm(value));
      return;
    }
    const nextValue = Number(rawValue);
    if (
      rawValue.trim() !== "" &&
      Number.isFinite(nextValue) &&
      nextValue >= MIN_BPM &&
      nextValue <= MAX_BPM
    ) {
      onCommit(nextValue);
      setDraft(formatBpm(nextValue));
      return;
    }
    setDraft(formatBpm(value));
  }

  return (
    <input
      type="number"
      min={MIN_BPM}
      max={MAX_BPM}
      step="0.1"
      inputMode="decimal"
      value={draft}
      disabled={disabled}
      aria-invalid={!valid}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onChange={(event) => {
        if (disabled) {
          return;
        }
        setDraft(event.target.value);
      }}
      onBlur={(event) => {
        focusedRef.current = false;
        if (skipBlurRef.current) {
          skipBlurRef.current = false;
          return;
        }
        commit(event.currentTarget.value);
      }}
      onKeyDown={(event) => {
        if (disabled) {
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          commit(event.currentTarget.value);
          skipBlurRef.current = true;
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          setDraft(formatBpm(value));
          skipBlurRef.current = true;
          event.currentTarget.blur();
        }
      }}
    />
  );
}
