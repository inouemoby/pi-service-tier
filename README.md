# pi-service-tier

Pi extension for configuring provider service tiers and toggling fast mode for the current session.

## Install

```bash
pi install git:github.com/inouemoby/pi-service-tier
```

## Commands

| Command | Description |
|---------|-------------|
| `/service-tier` | Edit global service-tier defaults for supported providers |
| `/fast` | Toggle the current provider's fast (`priority`) tier for this session |

Configuration changes take effect on the next provider request; no Pi restart is needed. Session `/fast` overrides take precedence over global defaults and are saved with the session branch. `/new` starts without session overrides.

## Providers and tiers

| Provider | Supported tiers | Fast tier |
|----------|-----------------|-----------|
| `openai` | `flex`, `priority` | `priority` |
| `openai-codex` | `flex`, `priority` | `priority` |
| `anthropic` | `priority`, `standard` | `priority` |
| `google` | `flex`, `priority` | `priority` |
| `google-vertex` | `flex`, `priority` | `priority` |

Global defaults are stored in `~/.pi/agent/service-tier.json`. Omit a provider to leave its tier unset. Example:

```json
{
  "openai": "priority",
  "openai-codex": "flex",
  "anthropic": "priority",
  "google": "priority",
  "google-vertex": "flex"
}
```

The optional footer indicator shows `⚡` when a supported tier is active. `openai-codex` fast mode uses a dedicated Codex WebSocket route. Displayed usage costs may not include service-tier price multipliers.

## License

MIT
