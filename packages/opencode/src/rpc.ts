import { Rpc } from "@opencode/plugin/rpc";

const Empty = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const Window = {
  type: "object",
  properties: {
    usedPercent: { type: "number" },
    pendingPercent: { type: "number" },
    resetsInMs: { type: "number" },
  },
  required: ["usedPercent", "pendingPercent", "resetsInMs"],
  additionalProperties: false,
} as const;

export const AfcUsage = Rpc.define({
  id: "agentfanclub.usage",
  methods: {
    get: {
      input: Empty,
      output: {
        type: "object",
        properties: {
          fiveHour: Window,
          weekly: Window,
        },
        required: ["fiveHour", "weekly"],
        additionalProperties: false,
      },
      errors: {
        not_connected: Empty,
        unavailable: Empty,
      },
    },
  },
  events: {},
});
