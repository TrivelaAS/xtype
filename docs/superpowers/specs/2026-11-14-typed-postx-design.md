# Typed PostX: first-version design

## Intent and agreed requirements

Hans wants a simple Chrome extension named Typed PostX. Hans or a bot supplies exact text for a new X post, a reply to a specific post, or a quote of a specific post. It uses the existing X login in Hans's Chrome profile. Hans selected a Windows helper for individual keyboard input and said commands should be sent to this computer.

Windows input is automation. This design does not promise to prevent spam detection or suspension, and does not include measures to conceal automation. X's published automation rules prohibit non-API website automation: https://help.x.com/en/rules-and-policies/x-automation.

## Approaches considered

1. Extension with Chrome debugger input: fewer installed components, but input originates through Chrome's automation interface.
2. Extension with Windows helper: selected by Hans. Uses Windows keyboard input and requires an unlocked desktop with Chrome in the foreground.
3. X's official publishing API: supports publishing without controlling the browser, but does not satisfy the keystroke requirement.

## Proposed scope

- One Windows computer, one selected Chrome profile, one expected X account.
- Text-only new posts, replies, and quote posts. Preserve the supplied text, including Norwegian characters and line breaks.
- Extension panel for manual submission, queue status, pause/resume, and cancellation of work that has not been published.
- A local HTTP endpoint for bot submissions, with a generated access token.
- One command at a time. Click Post after the text, target, and account have been checked. An optional draft mode stops before publication; ordinary submit commands publish automatically.
- Login, two-factor authentication, and any website verification are handled by Hans. The worker pauses when they are needed.

Media attachments, threads, scheduling, multiple accounts, content generation, remote hosting, and Chrome Web Store publication are outside the first version.

## Components

### Chrome extension

Use Manifest V3 with a small panel, a service worker, and an X-specific content script. The script reads page state and locates the visible compose, reply, quote, and publish controls. It never fills an editor by setting its value, assigning textContent, pasting, or injecting a bulk text-edit operation. Ordinary UI navigation and clicks are allowed; all supplied post text goes through the Windows helper.

The extension connects to the helper over an authenticated loopback WebSocket. Heartbeats keep the service worker active while connected; reconnection and persisted job state handle browser restarts. Permissions are restricted to the functions used and the X and loopback hosts. Pairing binds the helper to the installed extension's ID.

### Windows helper

Use C#/.NET with a documented start command and a self-contained build option. The dotnet host is present on this computer, but no SDK was listed; building requires an SDK or a suitable compiler to be made available. Listen only on 127.0.0.1, tentatively port 17843. Provide an authenticated HTTP job API and an authenticated WebSocket for the extension. Do not open a firewall port, enable startup automatically, or expose an unauthenticated network listener.

Use Windows SendInput to send individual key-down/key-up pairs with configurable pacing. Use the active keyboard layout for supported characters and Windows Unicode keyboard events where necessary. Enter handles line breaks. Never use the clipboard or a paste shortcut. Do not simulate intentional mistakes, fingerprints, or anti-detection behavior.

Before typing, identify and verify the intended Chrome window and have the extension verify the active tab and focused editor. Monitor foreground-window and tab changes during typing and stop on mismatch. Do not blindly resume partial typing: inspect the draft and reconcile against the original job first. An immediate stop control interrupts further input. Windows-level input requires an unlocked interactive session.

### Bot connection

For the first version, clients on this computer call POST /jobs with a bearer token. This is an implementation assumption: "send it to this computer" establishes the destination, but does not establish where every bot runs. Remote machines cannot reach a loopback endpoint; remote delivery would require a separately configured authenticated relay or tunnel, which is not included or implicitly authorized.

Example job:

```json
{
  "id": "caller-generated-unique-id",
  "action": "REPLY-TO",
  "url": "https://x.com/example/status/1234567890",
  "text": "Exact reply text",
  "mode": "publish"
}
```

Actions are NEW-POST, REPLY-TO, and QUOTE. NEW-POST omits url. Mode is publish or draft. The panel also accepts the requested command notation, with the target URL on its own line and the text following it. Validate and normalize X post URLs, reject empty text and unknown actions, and impose request-size limits. GET /jobs/{id} reports status and a resulting post URL when verified.

## Execution and recovery

Persist job IDs and state locally. States include queued, opening, typing, ready, submitting, published, draft-ready, needs-attention, and cancelled. A repeated job ID returns the existing job; a changed payload under the same ID is rejected.

Confirm the expected account before every job. For replies and quotes, check the target post identity before entering text. Respect the live composer's validation rather than assuming one universal character limit. Read the completed editor back and compare it with the requested content before publishing, accounting only for browser newline normalization.

Record submission intent durably before clicking Post. If the click may have succeeded but confirmation is missing, mark needs-attention and never automatically click again. Report published only when the newly created post can be verified; otherwise preserve uncertainty. Connection loss, page changes, invalid content, focus loss, and login prompts stop the job with a specific explanation.

## Security and storage

Generate a local token during setup; never put it in source control or logs. Authenticate every job and control request. Validate browser origins on the helper, restrict the extension connection to the paired extension, and avoid permissive CORS. Store queued text and job results locally in the current user's app-data directory with documented retention. Never collect X passwords or export session cookies.

## Validation and delivery

Deliver source, extension files loadable through Chrome's Load unpacked action, helper build/run instructions, and bot request examples. Verify command validation, job deduplication, uncertain-submit recovery, and the absence of clipboard/bulk-editor fallbacks. Test actual Windows keystrokes and focus interruption against a local test composer first. Exercise new-post, reply, and quote navigation on X in draft mode when Hans's browser session is available. Publishing a live test post requires a specific test message and Hans's authorization; building the software alone is not authorization to publish arbitrary test content.

## Builder decisions and outstanding assumptions

C#/.NET, loopback transport, port 17843, local-only initial bot access, single-account scope, automatic publication for publish-mode commands, and text-only scope are proposed implementation choices. Hans has not yet approved this written design. The most material assumption is that local bot access is sufficient for version one; a remote bot sender changes the connection setup.
