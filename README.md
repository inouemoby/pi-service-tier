# ⚡ pi-service-tier

A [Pi](https://pi.dev) extension that toggles fast mode and applies provider
service tiers.

## 🚀 Installation

```sh
pi install https://github.com/inouemoby/pi-service-tier.git
```

## ✨ What it does

- Adds service tier parameters to supported provider requests when a tier is
  configured
- Adds `/fast` to toggle the current model provider between fast mode and off
  for this session only
- Adds `/service-tier` to configure global defaults for all supported providers
  from an interactive modal
- Adds an optional service tier widget when `pi-fancy-footer` is installed
- Publishes active tier state for cooperating footer extensions
- Uses the Codex-client WebSocket route for Codex Fast requests without changing
  Pi core, the model catalog, OAuth handling, or other footer extensions

## 🚀 Commands

- `/fast`: toggles the current model provider between its fast tier and off
  **in this session**, without changing other sessions or your global defaults.
  The supported providers all use `priority` as the fast tier.

- `/service-tier`: opens an interactive editor for **global defaults**. The
  current model provider appears first, followed by the remaining supported
  providers. Press Enter or Space to cycle through `off` and the provider-specific
  tiers. Session overrides take precedence over these defaults.

### Session scope

Run `/fast` in the session you want to speed up, then run it again to turn fast
mode off. Each provider has its own override, so switching models preserves your
choices. Turning fast mode off also overrides a globally configured tier; it
leaves that provider's request parameters unchanged rather than restoring `flex`
or `standard`.

Overrides are saved with the session and restored on resume or extension reload.
They follow the active conversation branch: `/tree` restores the choices at the
selected point, and `/fork` or `/clone` inherits the choices on the copied branch.
Later toggles in a fork do not affect its parent. `/new` starts without overrides
and uses your global defaults.

## ⚙️ Configuration

Run `/service-tier` or create `~/.pi/agent/service-tier.json` to set global defaults:

```json
{
  "openai": "priority",
  "openai-codex": "flex",
  "anthropic": "priority",
  "google": "priority",
  "google-vertex": "flex"
}
```

### Supported providers

| Provider        | Tiers                  | Fast tier  |
| --------------- | ---------------------- | ---------- |
| `openai`        | `flex`, `priority`     | `priority` |
| `openai-codex`  | `flex`, `priority`     | `priority` |
| `anthropic`     | `priority`, `standard` | `priority` |
| `google`        | `flex`, `priority`     | `priority` |
| `google-vertex` | `flex`, `priority`     | `priority` |

To turn a provider off by default, omit its key. Only the values listed above are
accepted. Providers without a session override continue to pick up global changes.
Existing global settings, including those saved by earlier versions of `/fast`,
remain in effect. Use `/service-tier` to change them.
Batch APIs are separate asynchronous APIs and are not configured by this
extension.

## Codex Fast transport

When `openai-codex` Fast is enabled (the `priority` selection), this fork uses
`wss://chatgpt.com/backend-api/codex/responses`, sends
`service_tier: "priority"`, and identifies the connection with
`originator: codex_cli_rs`. This deliberately uses the Codex client's identity
for these requests; standard requests keep Pi's original identity and transport.
It follows the routing tested in [OpenCode #39882](https://github.com/anomalyco/opencode/pull/39882).

The extension registers only a streaming handler through Pi's provider API.
Pi still supplies the existing OAuth credentials/refresh, model catalog, message
and tool/image conversion, and response parsing. The adapter bridges WebSocket
frames into the stock stream parser in memory: no HTTP inference request is sent.
A new WebSocket is opened per request and closed at the final event or cancellation.
No socket is reused across Standard/Fast modes. Provider-scoped HTTP/HTTPS proxy
settings and cancellation are honored. Connection failures are reported instead
of silently falling back to standard HTTP/SSE routing. Fast-off and other
providers are unaffected. The same transport applies to Pi's model-based summaries
when they use the Codex provider and Fast is enabled.

On September 30, 2026, three alternating pairs on GPT-6 Luna (low reasoning,
identical 160-integer output, 323 output tokens per response) gave median total
times of 7.987 s for Standard and 5.558 s for Fast (~1.44x). All six final responses
still reported `service_tier: "default"`. This is a small account-specific test,
not a latency guarantee. The local `pi-service-tier:codex-result` event reports
whether the Fast WebSocket path completed, not proof of a backend SLA; it contains
only provider/model identity, transport, originator and success flags, never
credentials, prompts or response content.

Do not use Codex's `default` echo as proof that Fast failed. The existing Codex
Usage icon code is not changed by this fork: its `!` still represents that raw
echo, which can remain `default` even when measured Fast throughput improves.

## 🧩 Footer widget

When [pi-fancy-footer](https://github.com/mavam/pi-fancy-footer) is installed,
the widget appears only when the active model uses a supported provider/API pair
and that provider has an effective tier after applying session overrides. It shows
a single `⚡` without the tier name to keep the footer compact.

The widget id is `pi-service-tier.service-tier`. It uses the current
`pi-fancy-footer` event protocol, with row `1`, position `8`, right alignment,
and no fill behavior by default. The extension has no package dependency on the
footer: it publishes a complete snapshot when its state changes and republishes
when the footer announces that it is ready.

When the customized `pi-codex-usage` extension is also installed, its model-name
marker follows the final provider response: `⚡` when the response reports the
fast tier, and `!⚡` when it explicitly reports a non-fast tier. Missing tier
metadata is treated as unknown and does not show `!`. The marker reflects
response metadata rather than independently verifying remote processing; it is
display-only and does not change the model ID or request.

## 📝 TODO

- Account for service-tier pricing in pi usage metrics. The extension currently
  injects the tier into the provider request payload, but pi's OpenAI Codex cost
  calculation reads the requested tier from provider options. Until pi exposes a
  first-class extension path for that option, displayed usage costs can omit
  flex or priority multipliers.

## 📄 License

[MIT](LICENSE)
