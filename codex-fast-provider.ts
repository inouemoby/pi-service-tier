import type { Api, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { streamSimpleOpenAICodexResponses as streamCodex } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCodexFastFetch } from "./codex-fast-transport.ts";
import { resolveEffectiveServiceTier, type ServiceTierSettings } from "./domain.ts";

export const CODEX_FAST_RESULT_EVENT = "pi-service-tier:codex-result";

// Registration changes only the streaming handler: built-in models and OAuth
// authentication/refresh are retained by Pi's provider composer.
export function registerCodexFastProvider(
  pi: ExtensionAPI,
  settings: () => ServiceTierSettings,
  transportFactory = createCodexFastFetch,
): void {
  pi.registerProvider("openai-codex", {
    api: "openai-codex-responses",
    streamSimple(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
      const codexModel = model as Model<"openai-codex-responses">;
      if (resolveEffectiveServiceTier(settings(), model) !== "priority") {
        return streamCodex(codexModel, context, options);
      }

      let connected = false;
      const fetchWebSocket = transportFactory({
        signal: options?.signal,
        env: options?.env,
        connectTimeoutMs: options?.websocketConnectTimeoutMs,
        idleTimeoutMs: options?.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : undefined,
        onOpen: () => { connected = true; },
      });
      const fastOptions = {
        ...options,
        serviceTier: "priority" as const,
        // The stock adapter is used for JSON conversion and stream parsing.
        // Its fetch is replaced with a strict WebSocket bridge. This is NOT
        // an HTTP request and cannot take the adapter's WS -> SSE fallback.
        transport: "sse" as const,
        fetch: fetchWebSocket,
        onPayload: async (payload: unknown, requestModel: Model<Api>) => {
          const transformed = await options?.onPayload?.(payload, requestModel);
          const next = transformed === undefined ? payload : transformed;
          if (!next || typeof next !== "object" || Array.isArray(next)) {
            throw new Error("Codex Fast payload must be an object");
          }
          return { ...next, service_tier: "priority" };
        },
      };
      const result = streamCodex(codexModel, context, fastOptions);
      // Only path completion is reported. Codex's default tier echo cannot
      // prove a downgrade; neither this event nor the icon claims a backend SLA.
      void result.result().then((message) => {
        pi.events.emit(CODEX_FAST_RESULT_EVENT, {
          provider: model.provider,
          modelId: model.id,
          fast: true,
          success: connected && message.stopReason !== "error" && message.stopReason !== "aborted",
          transport: "websocket",
          originator: "codex_cli_rs",
        });
      }, () => {
        pi.events.emit(CODEX_FAST_RESULT_EVENT, {
          provider: model.provider,
          modelId: model.id,
          fast: true,
          success: false,
          transport: "websocket",
          originator: "codex_cli_rs",
        });
      });
      return result;
    },
  });
}
