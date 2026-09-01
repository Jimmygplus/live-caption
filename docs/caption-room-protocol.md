# Caption Room protocol

This document is the durable handoff for the encrypted QR caption room. GitHub Issue #17 is the delivery record; GitHub Project #3 is the planning source of truth. Linear is not used.

## Trust boundary

- The host creates separate random host and join capabilities.
- Only token hashes are sent when the room is created or authenticated.
- The join capability stays in the QR URL fragment, is copied into `sessionStorage`, then removed from the address bar.
- Caption and participant payloads use AES-GCM with a key derived from the join capability.
- The event or message ID is AES-GCM additional authenticated data.
- The relay can see room metadata, ordering IDs, ciphertext size and timing, but not caption or participant plaintext.

## Flow

1. The host publishes throttled `draft` captions. They are broadcast but not persisted.
2. The host publishes `final` captions with `persist: true`.
3. Later translation or correction events reuse the same `captionId` and increase `revision`.
4. QR clients upsert by `captionId`, ignore stale revisions, and remove `live-draft` when a final speech caption arrives.
5. Participant text is encrypted to the host. The host validates and renders it, publishes it as a typed final caption, then acknowledges the participant message.
6. Reconnecting QR clients receive at most 100 recent final ciphertext envelopes. Drafts are never replayed.
7. Host clients send a heartbeat every 10 seconds. The relay marks the room `away` after 30 seconds without a heartbeat, while keeping encrypted participant messages queued for host recovery.
8. A host refresh in the same tab restores the room capability from `sessionStorage`; the capability is never written to `localStorage`.

## Roles and messages

- Participant may send `message`; host may send `ack`, `caption`, and `close-room`.
- Host may send `heartbeat`; relay sends `host-status` with `online` or `away` to participants.
- `ready` includes the room expiry and current host status. `queued` includes the host status at acceptance time so the participant can distinguish immediate delivery from offline queueing.
- Only the host can publish `caption` envelopes.
- `caption` exposes `eventId`, `captionId`, `captionSeq`, `persist`, `iv`, and `ciphertext` to the relay.
- Encrypted payload fields are `captionId`, `captionSeq`, `revision`, `state`, `orig`, `trans`, `source`, `author`, `speaker`, `startMs`, `replacesDraft`, and `updatedAt`.

## Invariants

- Never put user text into the DOM with HTML parsing; use `textContent`.
- Never put vendor keys or the host capability into the QR URL.
- Do not let participant clients publish captions directly.
- Keep replay bounded and ciphertext-only.
- Presence is room-level only. Do not expose host identity, participant identity, stable device identifiers, or plaintext as presence metadata.
- Host recovery material is tab-scoped and expires with the room. Closing the tab intentionally does not create a long-lived host credential.
- Preserve the legacy Node text-input route until it is intentionally replaced.
