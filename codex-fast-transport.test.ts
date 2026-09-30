import assert from "node:assert/strict";
import { once, EventEmitter } from "node:events";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";
import WebSocket, { WebSocketServer } from "ws";
import { createCodexFastFetch, resolveProxy, type ConnectWebSocket } from "./codex-fast-transport.ts";

const upstream = "https://chatgpt.com/backend-api/codex/responses";
const payload = { model: "gpt-6-luna", service_tier: "priority", input: [{ role: "user", content: "hello" }] };

async function withServer(fn: (connect: ConnectWebSocket, server: WebSocketServer) => Promise<void>) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const connect: ConnectWebSocket = (url, headers) => {
    assert.equal(url, "wss://chatgpt.com/backend-api/codex/responses");
    return new WebSocket(`ws://127.0.0.1:${address.port}`, { headers });
  };
  try { await fn(connect, server); }
  finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function init(body = payload): RequestInit {
  return { method: "POST", headers: { authorization: "Bearer test-only", originator: "pi" }, body: JSON.stringify(body) };
}

test("Fast uses Codex WS headers and preserves the zstd-decoded request and events", async () => {
  await withServer(async (connect, server) => {
    server.on("connection", (socket, request) => {
      assert.equal(request.headers.originator, "codex_cli_rs");
      assert.equal(request.headers.authorization, "Bearer test-only");
      assert.equal(request.headers["openai-beta"], "responses_websockets=2026-02-06");
      assert.equal(request.headers["content-encoding"], undefined);
      assert.ok(request.headers["session-id"]);
      socket.on("message", (raw) => {
        assert.deepEqual(JSON.parse(raw.toString()), { ...payload, type: "response.create" });
        socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "你好" }));
        socket.send(JSON.stringify({ type: "response.completed", response: { service_tier: "default", status: "completed" } }));
      });
    });
    let opened = 0;
    const request = init();
    request.headers = { ...request.headers, "content-encoding": "zstd" };
    request.body = new Uint8Array(zstdCompressSync(JSON.stringify(payload)));
    const response = await createCodexFastFetch({ onOpen: () => opened++ }, connect)(upstream, request);
    assert.equal(response.headers.get("x-pi-codex-transport"), "websocket");
    const events = await response.text();
    assert.match(events, /你好/);
    assert.match(events, /"service_tier":"default"/);
    assert.equal(opened, 1);
  });
});

test("wrong host and missing tier fail before connecting", async () => {
  let connects = 0;
  const connect: ConnectWebSocket = () => { connects++; throw new Error("must not connect"); };
  const fetchFast = createCodexFastFetch({}, connect);
  await assert.rejects(fetchFast("https://example.com/backend-api/codex/responses", init()), /ChatGPT Codex endpoint/);
  await assert.rejects(fetchFast(upstream, { ...init(), body: JSON.stringify({ model: "gpt-6-luna" }) }), /service_tier/);
  assert.equal(connects, 0);
});

test("connection timeout fails without making a standard HTTP request", async () => {
  let terminated = false;
  const socket = new EventEmitter() as EventEmitter & { terminate(): void };
  socket.terminate = () => { terminated = true; };
  const fetchFast = createCodexFastFetch({ connectTimeoutMs: 10 }, () => socket as unknown as WebSocket);
  await assert.rejects(fetchFast(upstream, init()), /connection timeout.*no standard fallback/);
  assert.equal(terminated, true);
});

test("early close and malformed data are errors, never normal-tier fallbacks", async () => {
  for (const malformed of [false, true]) {
    await withServer(async (connect, server) => {
      server.on("connection", (socket) => {
        socket.on("message", () => {
          if (malformed) socket.send("not-json");
          else socket.close();
        });
      });
      const response = await createCodexFastFetch({}, connect)(upstream, init());
      await assert.rejects(response.text(), malformed ? /invalid JSON/ : /closed before/);
    });
  }
});

test("abort and stream cancellation close the WS connection", async () => {
  await withServer(async (connect, server) => {
    const connected = once(server, "connection");
    const abort = new AbortController();
    const response = await createCodexFastFetch({ signal: abort.signal }, connect)(upstream, init());
    const [socket] = await connected;
    const closed = once(socket, "close");
    abort.abort();
    await assert.rejects(response.text(), /aborted/);
    await closed;
  });
  await withServer(async (connect, server) => {
    const connected = once(server, "connection");
    const response = await createCodexFastFetch({}, connect)(upstream, init());
    const [socket] = await connected;
    const closed = once(socket, "close");
    await response.body!.cancel();
    await closed;
  });
});

test("per-provider proxy settings and no_proxy are honored", () => {
  const env = { https_proxy: "http://127.0.0.1:8080", HTTPS_PROXY: "", all_proxy: "", ALL_PROXY: "", no_proxy: "", NO_PROXY: "" };
  assert.equal(resolveProxy(new URL(upstream), env), "http://127.0.0.1:8080/");
  assert.equal(resolveProxy(new URL(upstream), { ...env, no_proxy: ".chatgpt.com:443" }), "");
  assert.throws(() => resolveProxy(new URL(upstream), { ...env, https_proxy: "socks://localhost:8080" }), /HTTP\/HTTPS/);
});
