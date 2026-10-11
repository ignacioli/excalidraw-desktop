import { useEffect, useState } from "react";
import { hasNativeWindowRuntime } from "../app/exitCheckpoint";

let homeDirectory: Promise<string | null> | undefined;

function readHomeDirectory(): Promise<string | null> {
  homeDirectory ??= hasNativeWindowRuntime()
    ? import("@tauri-apps/api/path")
        .then(({ homeDir }) => homeDir())
        .catch(() => null)
    : Promise.resolve(null);
  return homeDirectory;
}

/** Show a path the way macOS tools do, with the home directory as `~`. */
export function abbreviateHome(path: string, home: string | null): string {
  const root = home?.replace(/\/+$/u, "") ?? "";
  if (root === "") return path;
  if (path === root) return "~";
  return path.startsWith(`${root}/`) ? `~${path.slice(root.length)}` : path;
}

/** The user's home directory, or null outside the desktop shell. */
export function useHomeDirectory(): string | null {
  const [home, setHome] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void readHomeDirectory().then((value) => {
      if (live) setHome(value);
    });
    return () => {
      live = false;
    };
  }, []);
  return home;
}
