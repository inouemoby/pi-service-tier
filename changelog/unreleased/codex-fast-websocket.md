---
title: Use the Codex WebSocket Fast route
type: fix
authors:
  - inouemoby
created: 2026-09-30T00:00:00.000000Z
---

Codex Fast requests now use the Codex-client originator and WebSocket transport
inside this extension, preserving Pi's built-in model catalog, OAuth handling,
request conversion and stream parsing. Connection errors no longer silently fall
back to standard HTTP/SSE requests. Standard requests and other providers retain
Pi's original behavior. Pi core and Codex Usage are not modified.

The response's `default` service-tier echo is not considered proof of failed Fast
routing. Three alternating Standard/Fast pairs on GPT-6 Luna produced a ~1.44x
median total-time improvement even though every response echoed `default`.
