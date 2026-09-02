import type { SeparatedTranscriptionSettings } from "../types";
import { Localized } from "../i18n";

interface SourceSeparationOptionsProps {
  settings: SeparatedTranscriptionSettings;
  onChange(settings: SeparatedTranscriptionSettings): void;
}

export function SourceSeparationOptions({
  settings,
  onChange,
}: SourceSeparationOptionsProps) {
  return (
    <Localized>
    <details className="source-separation-details" open>
      <summary>音源分離後の採譜方法</summary>
      <fieldset className="source-separation-options">
        <legend className="visually-hidden">音源分離後の採譜方法</legend>
        <label className="source-separation-option">
          <span>
            <strong>音源分離後の発音開始時刻の誤差を低減する</strong>
            <small>Bass、Piano、Guitar、Vocal、Otherの分離後音源へドラム成分を20%加えて採譜します</small>
          </span>
          <input
            type="checkbox"
            checked={settings.drumOnsetGuide}
            onChange={(event) => {
              const checked = event.target.checked;
              onChange({
                ...settings,
                drumOnsetGuide: checked,
                ...(!checked ? { timingGuideNoteFilter: false } : {}),
              });
            }}
          />
          <span className="toggle-track" aria-hidden="true">
            <span />
          </span>
        </label>
      </fieldset>
    </details>
    </Localized>
  );
}
