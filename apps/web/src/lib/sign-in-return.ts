// Only an application approval page can override the normal post-login destination.
export function signInReturn(value: unknown) {
  return typeof value === "string" && /^\/connect\/(?:opencode|pi|oh-my-pi)\?code=[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/.test(value)
    ? value
    : "/";
}
