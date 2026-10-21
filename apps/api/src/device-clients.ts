export const deviceClients = {
  opencode: "OpenCode",
  pi: "Pi",
  "oh-my-pi": "Oh My Pi",
} as const;

export type DeviceClient = keyof typeof deviceClients;

export function isDeviceClient(value: unknown): value is DeviceClient {
  return typeof value === "string" && Object.hasOwn(deviceClients, value);
}
