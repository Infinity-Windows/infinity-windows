import { useDisplayMode, type DisplayMode } from "../lib/displayMode";
import { useT } from "../lib/i18n";

export function DisplayModePicker() {
  const { mode, setMode } = useDisplayMode();
  const t = useT();
  return (
    <label className="display-mode-picker">
      <span>{t("display.heading")}</span>
      <select value={mode} onChange={e => setMode(e.target.value as DisplayMode)}>
        <option value="auto">{t("display.auto")}</option>
        <option value="phone">{t("display.phone")}</option>
        <option value="desktop">{t("display.desktop")}</option>
      </select>
    </label>
  );
}
