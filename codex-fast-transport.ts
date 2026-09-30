import { randomUUID } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
import { HttpsProxyAgent } from "https-proxy-agent";
import WebSocket from "ws";

export const CODEX_FAST_ORIGINATOR = "codex_cli_rs";
const CODEX_CLIENT_VERSION = "0.157.1";

export interface FastTransportOptions {
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  env?: Record<string, string>;
  onOpen?: () => void;
}

export function resolveProxy(url: URL, env?: Record<string, string>): string {
  const source = { ...process.env, ...env };
  const noProxy = (source.no_proxy || source.NO_PROXY || "").toLowerCase();
  const host = url.hostname.toLowerCase();
  const port = url.port || "443";
  for (let entry of noProxy.split(/[\s,]+/)) {
    if (!entry) continue;
    if (entry === "*") return "";
    const parts = entry.split(":");
    if (parts.length === 2) {
      if (parts[1] !== port) continue;
      entry = parts[0];
    }
    if (entry.startsWith("*")) entry = entry.slice(1);
    if (entry.startsWith(".")) {
      if (host.endsWith(entry) || host === entry.slice(1)) return "";
    } else if (host === entry) return "";
  }
  const value = source.https_proxy || source.HTTPS_PROXY || source.all_proxy || source.ALL_PROXY;
  if (!value) return "";
  const proxy = new URL(value.includes("://") ? value : `http://${value}`);
  if (proxy.protocol !== "http:" && proxy.protocol !== "https:") {
    throw new Error("Codex Fast only supports HTTP/HTTPS proxies");
  }
  return proxy.toString();
}

export type ConnectWebSocket = (
  url: string,
  headers: Record<string, string>,
  proxy: string,
) => WebSocket;

function connectWebSocket(
  url: string,
  headers: Record<string, string>,
  proxy: string,
): WebSocket {
  return new WebSocket(url, {
    headers,
    ...(proxy ? { agent: new HttpsProxyAgent(proxy) } : {}),
    maxPayload: 64 * 1024 * 1024,
  });
}

// Uses Pi's existing request conversion and SSE response parser. The wire
// transport here is strictly WebSocket, not HTTP, and cannot fall back to SSE.
export function createCodexFastFetch(
  options: FastTransportOptions = {},
  connect: ConnectWebSocket = connectWebSocket,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== "https://chatgpt.com" || url.pathname !== "/backend-api/codex/responses") {
      throw new Error("Codex Fast transport requires the ChatGPT Codex endpoint");
    }
    const headers = new Headers(init?.headers);
    const bodyBytes = typeof init?.body === "string"
      ? Buffer.from(init.body)
      : init?.body instanceof Uint8Array
        ? Buffer.from(init.body)
        : undefined;
    if (!bodyBytes) throw new Error("Codex Fast request body is not supported");
    const decoded = headers.get("content-encoding") === "zstd"
      ? zstdDecompressSync(bodyBytes)
      : bodyBytes;
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(decoded.toString("utf8")); }
    catch { throw new Error("Codex Fast request must be valid JSON"); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.service_tier !== "priority") {
      throw new Error("Codex Fast request must contain service_tier: priority");
    }

    headers.delete("content-encoding");
    headers.delete("content-type");
    headers.delete("accept");
    headers.set("originator", CODEX_FAST_ORIGINATOR);
    headers.set("User-Agent", `${CODEX_FAST_ORIGINATOR}/${CODEX_CLIENT_VERSION}`);
    headers.set("OpenAI-Beta", "responses_websockets=2026-02-06");
    const requestId = headers.get("session-id") || randomUUID();
    headers.set("session-id", requestId);
    headers.set("x-client-request-id", requestId);
    const proxy = resolveProxy(url, options.env);
    url.protocol = "wss:";

    const signal = options.signal ?? init?.signal ?? undefined;
    if (signal?.aborted) throw new DOMException("Request aborted", "AbortError");
    return new Promise<Response>((resolve, reject) => {
      let socket: WebSocket | undefined;
      let opened = false;
      let ended = false;
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const encoder = new TextEncoder();
      const cleanup = () => {
        clearTimeout(connectTimer);
        clearTimeout(idleTimer);
        signal?.removeEventListener("abort", abort);
        socket?.terminate();
      };
      const fail = (error: Error) => {
        if (ended) return;
        ended = true;
        if (opened) controller.error(error);
        else reject(error);
        cleanup();
      };
      const abort = () => fail(new DOMException("Request aborted", "AbortError"));
      const armIdleTimeout = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () => fail(new Error("Codex Fast WebSocket idle timeout (no standard fallback)")),
          options.idleTimeoutMs ?? 300_000,
        );
      };
      const stream = new ReadableStream<Uint8Array>({
        start(nextController) { controller = nextController; },
        cancel() {
          if (ended) return;
          ended = true;
          cleanup();
        },
      });
      signal?.addEventListener("abort", abort, { once: true });
      connectTimer = setTimeout(
        () => fail(new Error("Codex Fast WebSocket connection timeout (no standard fallback)")),
        options.connectTimeoutMs ?? 15_000,
      );
      try {
        socket = connect(url.toString(), Object.fromEntries(headers.entries()), proxy);
        socket.on("error", () => fail(new Error("Codex Fast WebSocket connection failed (no standard fallback)")));
        socket.on("unexpected-response", (request, response) => {
          response.resume();
          request.destroy();
          fail(new Error(`Codex Fast WebSocket handshake rejected: HTTP ${response.statusCode}`));
        });
        socket.on("open", () => {
          if (ended) return;
          opened = true;
          clearTimeout(connectTimer);
          armIdleTimeout();
          resolve(new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream", "x-pi-codex-transport": "websocket" },
          }));
          try {
            options.onOpen?.();
            socket!.send(JSON.stringify({ ...payload, type: "response.create" }));
          } catch { fail(new Error("Codex Fast WebSocket send failed")); }
        });
        socket.on("message", (raw) => {
          if (ended) return;
          armIdleTimeout();
          let event: Record<string, unknown>;
          try { event = JSON.parse(raw.toString()); }
          catch { fail(new Error("Codex Fast WebSocket returned invalid JSON")); return; }
          if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string") {
            fail(new Error("Codex Fast WebSocket returned an invalid event")); return;
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          if (["response.completed", "response.done", "response.incomplete", "response.failed", "error"].includes(event.type)) {
            ended = true;
            controller.close();
            cleanup();
          }
        });
        socket.on("close", () => {
          if (!ended) fail(new Error("Codex Fast WebSocket closed before the final response"));
        });
        // An abort may have happened synchronously inside an injected connector.
        if (signal?.aborted) abort();
      } catch {
        fail(new Error("Codex Fast WebSocket setup failed (no standard fallback)"));
      }
    });
  };
}
