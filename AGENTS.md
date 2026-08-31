# Agent working agreement

Read this file, `README.md`, the active GitHub Issue, and any directly linked document before changing the project.

## Project management

- GitHub Project #3, GitHub Issues, and Milestones are the only planning source of truth. Do not sync Linear.
- Work in two-week Sprints. Keep one main product Issue in progress at a time.
- Do not implement future backlog merely because it is documented.
- Definition of Done: acceptance criteria, automated tests, browser verification, CI/CD deployment, production verification, and an evidence comment before closing the Issue.
- Public `live-caption` validates product value first. Account, audit, SLA, durable storage, enterprise integration, and high-availability follow-ups belong in `live-caption-cloud` backlog and should link back to the public Issue.

## Architecture and safety

- Static GitHub Pages is a first-class deployment. Browser-to-provider streaming must continue to work without the Node server.
- The Cloudflare relay must remain unable to read caption or participant plaintext. See `docs/caption-room-protocol.md`.
- Never commit `.env`, credentials, provider keys, QR capabilities, or captured user speech.
- Render user-controlled content with `textContent`, not `innerHTML`.
- Default audio input is the microphone. Browser/system capture is an explicit option.

## Verification

- Run `npm test` and syntax checks for changed JavaScript.
- For relay changes, run a Wrangler dry run and the encrypted multi-client protocol test.
- For UI changes, verify the host plus two independent QR clients locally, then verify the deployed GitHub Pages URL.
