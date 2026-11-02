import { APP_LANGUAGE_OPTIONS, useAppLanguage, type AppLanguage } from "../i18n";

interface LanguageSelectProps {
  className?: string;
}

export function LanguageSelect({ className }: LanguageSelectProps) {
  const { language, setLanguage } = useAppLanguage();

  return (
    <label className={className ?? "language-select"}>
      <span>Language</span>
      <select
        aria-label="Language"
        value={language}
        onChange={(event) => setLanguage(event.target.value as AppLanguage)}
      >
        {APP_LANGUAGE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
