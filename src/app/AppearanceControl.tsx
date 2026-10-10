import { useSyncExternalStore } from "react";
import { useI18n, type MessageKey } from "../i18n";
import type { ThemeController } from "./theme/themeController";
import type { ModePreference } from "./theme/types";

interface AppearanceControlProps {
  controller: ThemeController;
}

const options: ReadonlyArray<{
  value: ModePreference;
  label: MessageKey;
}> = [
  { value: "light", label: "appearance.light" },
  { value: "dark", label: "appearance.dark" },
  { value: "system", label: "appearance.system" },
];

export function AppearanceControl({ controller }: AppearanceControlProps) {
  const { t } = useI18n();
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  return (
    <fieldset className="appearance-control">
      <legend>{t("appearance.legend")}</legend>
      <div className="appearance-options">
        {options.map((option) => (
          <label className="appearance-option" key={option.value}>
            <input
              checked={snapshot.preference.modePreference === option.value}
              name="appearance"
              onChange={() => controller.setModePreference(option.value)}
              type="radio"
              value={option.value}
            />
            <span>{t(option.label)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
