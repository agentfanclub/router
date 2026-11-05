import type { ParsedUsage } from "./usage";
import { parseOpenAiUsage } from "./usage";

// Capture terminal events before forwarding them. Clients can stop reading as
// soon as they receive [DONE], without waiting for the HTTP body to close.
export function usageCaptureTransform({ clientWantsUsage, onFinish, onError }: {
  clientWantsUsage: boolean;
  onFinish: (status: "ok" | "error" | "aborted", usage: ParsedUsage | null) => Promise<void>;
  onError: (error: unknown) => void;
}): { transform: TransformStream<Uint8Array, Uint8Array>; finish: (status: "ok" | "error" | "aborted") => Promise<void> } {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let captured: ParsedUsage | null = null;
  let upstreamError = false;
  let terminalEvents = "";
  let completion: Promise<void> | undefined;

  const finish = (status: "ok" | "error" | "aborted") => {
    completion ??= onFinish(upstreamError ? "error" : status, captured).catch((error) => {
      console.error("usage finalize failed", error);
    });
    return completion;
  };

  const event = async (raw: string): Promise<string> => {
    const lines = raw.split("\n");
    const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (data.trim() === "[DONE]") {
      await finish("ok");
      const output = terminalEvents + raw + "\n\n";
      terminalEvents = "";
      return output;
    }
    const errorEvent = lines.some((line) => /^event:\s*error\s*$/.test(line));
    let parsed: { usage?: unknown; choices?: { finish_reason?: unknown }[]; error?: unknown } = {};
    if (data) {
      try {
        const value: unknown = JSON.parse(data);
        if (value && typeof value === "object") parsed = value;
      } catch {
        // Forward non-JSON events unchanged, but still honor event: error.
      }
    }
    if (parsed.usage !== undefined) captured = parseOpenAiUsage(parsed.usage) ?? captured;
    if (parsed.error != null || errorEvent) {
      upstreamError = true;
      onError(parsed.error);
      await finish("error");
    }
    if (!clientWantsUsage && Array.isArray(parsed.choices) && parsed.choices.length === 0 && parsed.usage !== undefined && parsed.error == null) {
      return "";
    }
    // Tool-call clients may close at finish_reason before reading usage.
    // Hold that event and everything after it until accounting is complete.
    if (terminalEvents || (Array.isArray(parsed.choices) && parsed.choices.some((choice) => choice?.finish_reason != null))) {
      terminalEvents += raw + "\n\n";
      return "";
    }
    return raw + "\n\n";
  };

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      // Normalize line endings only once a complete line has arrived, so CRLF
      // split across network chunks is handled correctly.
      buffer += decoder.decode(chunk, { stream: true });
      let boundary = /\r?\n\r?\n/.exec(buffer);
      while (boundary) {
        const raw = buffer.slice(0, boundary.index).replace(/\r\n/g, "\n");
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const output = await event(raw);
        if (output) controller.enqueue(encoder.encode(output));
        boundary = /\r?\n\r?\n/.exec(buffer);
      }
    },
    async flush(controller) {
      buffer += decoder.decode();
      if (buffer) {
        const output = await event(buffer.replace(/\r\n/g, "\n"));
        if (output) controller.enqueue(encoder.encode(output));
      }
      await finish(captured ? "ok" : "aborted");
      if (terminalEvents) controller.enqueue(encoder.encode(terminalEvents));
    },
    cancel() {
      return finish("aborted");
    },
  });
  return { transform, finish };
}
