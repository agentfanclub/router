import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import { createProvider } from "./provider";
import { installUsageUI, type UsageApi } from "./ui";

export default function (pi: ExtensionAPI) {
  const { baseUrl, oauth, fetchModels, fetchUsage } = createProvider("oh-my-pi");
  pi.registerProvider("agentfanclub", {
    baseUrl,
    api: "openai-completions",
    authHeader: true,
    oauth,
    models: [],
    fetchDynamicModels: (token) => fetchModels(token),
  } satisfies ProviderConfig);

  installUsageUI(pi as unknown as UsageApi, fetchUsage);
}
