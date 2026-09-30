import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { normalizeContext, type Model } from "@earendil-works/pi-ai/compat";
import { zstdDecompressSync } from "node:zlib";
import { registerCodexFastProvider } from "./codex-fast-provider.ts";

const model = {
  provider: "openai-codex", api: "openai-codex-responses", id: "gpt-6-luna",
  name: "Luna", baseUrl: "https://chatgpt.com/backend-api", reasoning: true,
  input: ["text"], contextWindow: 1_000_000, maxTokens: 128_000,
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
} as Model<"openai-codex-responses">;
const token = `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64")}.b`;
const context = normalizeContext({ systemPrompt: "helpful", messages: [{ role: "user", content: "test", timestamp: 1 }] });

function response(error = false) {
  const event = error
    ? { type: "response.failed", response: { error: { message: "test failure" } } }
    : { type: "response.completed", response: { status: "completed", service_tier: "default", usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } };
  return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
}

function harness(fast: boolean, transportFactory?: Parameters<typeof registerCodexFastProvider>[2]) {
  let config: ProviderConfig | undefined;
  const events: Array<{ name: string; data: unknown }> = [];
  registerCodexFastProvider({
    registerProvider(name: string, next: ProviderConfig) {
      assert.equal(name, "openai-codex");
      config = next;
    },
    events: { emit(name: string, data: unknown) { events.push({ name, data }); } },
  } as unknown as ExtensionAPI, () => fast ? { "openai-codex": "priority" } : {}, transportFactory);
  assert.ok(config?.streamSimple);
  assert.equal(config.models, undefined);
  assert.equal(config.oauth, undefined);
  assert.equal(config.apiKey, undefined);
  return { run: config.streamSimple, events };
}

test("normal mode retains the original fetch, transport and onPayload", async () => {
  let calls = 0;
  const h = harness(false, () => { throw new Error("Fast must not be activated"); });
  const result = await h.run(model, context, {
    apiKey: token, transport: "sse",
    onPayload: (body) => ({ ...(body as object), test_hook: true }),
    fetch: async (_url, options) => {
      calls++;
      const headers = new Headers(options?.headers);
      const bytes = options?.body as Uint8Array;
      const body = JSON.parse((headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes).toString());
      assert.equal(body.test_hook, true);
      assert.equal(body.service_tier, undefined);
      return response();
    },
  }).result();
  assert.equal(result.stopReason, "stop");
  assert.equal(calls, 1);
  assert.equal(h.events.length, 0);
});

test("Fast overrides only transport and tier, preserves hooks, and accepts a default echo", async () => {
  let hookCount = 0;
  let rawCount = 0;
  const h = harness(true, (opts) => async (_url, options) => {
    opts?.onOpen?.();
    const bytes = options?.body as Uint8Array;
    const body = JSON.parse(zstdDecompressSync(bytes).toString());
    assert.equal(body.service_tier, "priority");
    assert.equal(body.test_hook, true);
    assert.equal(body.model, "gpt-6-luna");
    const headers = new Headers(options?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${token}`);
    return response();
  });
  const result = await h.run(model, context, {
    apiKey: token, transport: "auto", reasoning: "low",
    onPayload: (body) => { hookCount++; return { ...(body as object), service_tier: "flex", test_hook: true }; },
    onProviderStreamEvent: () => { rawCount++; },
    fetch: async () => { throw new Error("Standard transport must not be used"); },
  }).result();
  await Promise.resolve();
  assert.equal(result.stopReason, "stop");
  assert.equal(hookCount, 1);
  assert.equal(rawCount, 1);
  assert.deepEqual(h.events.at(-1)?.data, {
    provider: "openai-codex", modelId: "gpt-6-luna", fast: true, success: true,
    transport: "websocket", originator: "codex_cli_rs",
  });
});

test("Fast connection failure is reported without falling back to standard", async () => {
  const h = harness(true, () => async () => { throw new Error("test WS failure"); });
  const result = await h.run(model, context, {
    apiKey: token,
    fetch: async () => { throw new Error("Must not fall back"); },
  }).result();
  await Promise.resolve();
  assert.equal(result.stopReason, "error");
  assert.equal((h.events.at(-1)?.data as { success: boolean }).success, false);
});
