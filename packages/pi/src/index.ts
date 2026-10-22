import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { createProvider } from "./provider";

export default function (pi: ExtensionAPI) {
  const { baseUrl, oauth, fetchModels } = createProvider("pi");
  pi.registerProvider("agentfanclub", {
    name: "Agent Fan Club",
    baseUrl,
    api: "openai-completions",
    authHeader: true,
    oauth,
    models: [],
    async refreshModels(context) {
      if (!context.allowNetwork) return [];
      const credential = context.credential;
      const token = credential?.type === "oauth" ? oauth.getApiKey(credential) : credential?.key;
      return fetchModels(token, context.signal);
    },
  } satisfies ProviderConfig);
}
