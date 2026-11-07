import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type Theme = "system" | "light" | "dark";
const ThemeContext = createContext<{ theme: Theme; setTheme: (theme: Theme) => void } | null>(null);

// Apply before paint so a saved preference does not flash the wrong theme.
export const themeScript = `try{var t=localStorage.getItem("theme");document.documentElement.classList.toggle("dark",t==="dark"||((t!=="light")&&matchMedia("(prefers-color-scheme: dark)").matches))}catch(e){document.documentElement.classList.toggle("dark",matchMedia("(prefers-color-scheme: dark)").matches)}`;

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme | null>(null);
  useEffect(() => {
    try {
      const saved = localStorage.getItem("theme");
      setTheme(saved === "light" || saved === "dark" ? saved : "system");
    } catch { setTheme("system"); }
  }, []);

  useEffect(() => {
    if (theme === null) return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", theme === "dark" || (theme === "system" && media.matches));
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  return <ThemeContext.Provider value={{ theme: theme ?? "system", setTheme: (value) => {
    setTheme(value);
    try { localStorage.setItem("theme", value); } catch { /* Keep the selection for this visit. */ }
  } }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme requires ThemeProvider");
  return context;
}
