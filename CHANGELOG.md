# Changelog

## 0.1.4

- Added the backward-compatible `NetworkEndpoint` and data-only `PeerLink` API.
- Reused one signaling registration and stable local Peer ID while retaining
  independent one-to-one peer connections.
- Added exact signal routing, per-link state, targeted send and aggregate
  endpoint cleanup.
- Kept membership, topology, broadcast, offerer selection, connection
  concurrency and reconnect policy outside the network package.
- Added centrally routed `RtcPeer.receiveSignal()` while preserving the existing
  self-subscribed one-to-one behavior by default.
- Added an explicit signaling `close()` lifecycle method.

The existing `NetworkClient` API and behavior remain available unchanged.
