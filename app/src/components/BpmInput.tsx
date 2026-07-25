import { useEffect, useRef, useState } from "react";

interface BpmInputProps {
  value: number;
  onCommit: (value: number) => void;
}

const MIN_BPM = 20;
const MAX_BPM = 300;

function formatBpm(value: number): string {
  return String(value);
}

export function BpmInput({ value, onCommit }: BpmInputProps) {
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
      aria-invalid={!valid}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onChange={(event) => {
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
