import { useSyncExternalStore } from "react";
import type { ThemeController } from "./theme/themeController";
import type { ModePreference } from "./theme/types";

interface AppearanceControlProps {
  controller: ThemeController;
}

const options: ReadonlyArray<{
  value: ModePreference;
  label: string;
}> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

export function AppearanceControl({ controller }: AppearanceControlProps) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  return (
    <fieldset className="appearance-control">
      <legend>Appearance</legend>
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
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
