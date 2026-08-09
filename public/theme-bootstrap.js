(() => {
  const root = document.documentElement;
  let modePreference = "system";

  try {
    const stored = localStorage.getItem("excalidraw-desktop.appearance");
    if (stored !== null) {
      const preference = JSON.parse(stored);
      if (
        preference?.version === 1 &&
        preference.themeId === "excalidraw" &&
        ["light", "dark", "system"].includes(preference.modePreference)
      ) {
        modePreference = preference.modePreference;
      }
    }
  } catch {
    // The application controller replaces inaccessible or invalid preferences.
  }

  const colorScheme =
    modePreference === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : modePreference;

  root.dataset.theme = "excalidraw";
  root.dataset.colorScheme = colorScheme;
  root.style.colorScheme = colorScheme;
})();
