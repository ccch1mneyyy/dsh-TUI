# 0008 — dsh-TUI Channel HTTP Endpoint

> TUI Profile 说明（随 dsh-TUI 代码修订；编号仅作稳定锚点）。

## Abstract

This document specifies an HTTP endpoint for discovering and establishing a dsh-TUI Channel connection. The endpoint carries `@dsh-std/connection` offers, agreements, capability invocations, progress, results, cancellation, and closure over a WebSocket. Agent, workspace, session, and presentation semantics are not defined by this transport.

## Endpoint

An implementation MUST expose the following resources from one HTTP origin:

| Path | Method | Semantics |
| --- | --- | --- |
| `/dsh-tui/v1/health` | `GET` | Liveness response |
| `/dsh-tui/v1/endpoint` | `GET` | Endpoint descriptor |
| `/dsh-tui/v1/connection` | WebSocket Upgrade | Standard connection frames |

The default listening address is `127.0.0.1:10721`. An implementation MUST NOT listen on a non-loopback address unless the operator explicitly selects that address.

## Endpoint descriptor

The descriptor response MUST use media type `application/json` and have this form:

```json
{
  "apiVersion": "tui.dsh/v1alpha1",
  "kind": "ChannelEndpoint",
  "origin": "http://127.0.0.1:10721",
  "connection": "/dsh-tui/v1/connection"
}
```

`origin` MUST identify the authority serving the descriptor. `connection` MUST be `/dsh-tui/v1/connection` in this revision.

## WebSocket connection

Each WebSocket message MUST contain one UTF-8 JSON text frame. Binary messages MUST be rejected. The first message sent by the connecting endpoint MUST be `connection/open` and contain its current `EndpointOffer`. The accepting endpoint MUST reply with `connection/opened`, its current offer, and the resolved `ConnectionPlan`.

After the handshake, either endpoint MAY send capability invocation, progress, result, cancellation, or closure frames. An endpoint whose offer changes MUST send `connection/offer`; the accepting endpoint MUST resolve a new plan and send `connection/plan`.

Participant identifiers carried by this endpoint MUST be unique across both offers. An adapter whose participant identifiers are local to one runtime MUST scope those identifiers by its endpoint instance before transmission and MUST restore its local identifiers before dispatch. This transformation MUST NOT change protocol declarations or endpoint identities.

A malformed frame, an invalid offer transition, an invocation outside the active plan, or a role-invalid handshake frame MUST close the logical connection. Capability handler failures MUST be returned as capability error results and MUST NOT terminate an otherwise valid connection.

## HTTP behavior

Unknown paths MUST return `404`. Unsupported methods MUST return `405`. Responses SHOULD include `Cache-Control: no-store`. Implementations MAY define authentication and TLS deployment policy outside this protocol revision.
