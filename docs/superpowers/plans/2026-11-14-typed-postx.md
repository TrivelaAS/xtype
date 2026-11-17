# Typed PostX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver a local Chrome extension and Windows typing helper for supplied X posts, replies, and quotes.

**Architecture:** A Node HTTP/WebSocket broker owns authenticated commands and a durable queue. A small C# executable performs individual Windows input operations over stdin/stdout. A Manifest V3 extension owns X navigation, editor checks, and publishing.

**Tech Stack:** Node 22+, ws, C# compiled with the installed .NET Framework compiler, plain browser JavaScript/CSS.

**Spec:** ../specs/2026-11-14-typed-postx-design.md

## Global Constraints

- Localhost 127.0.0.1:17843 only; generated bearer token; one paired extension.
- Text-only, one account, one job at a time; NEW-POST / REPLY-TO / QUOTE.
- All text enters through Windows key events; no paste, editor assignment, or bulk text insertion.
- Halt on focus loss, login requirements, content mismatch, or uncertain publication.
- No live public test posts without specific user-approved content.

## Review Focus

- Duplicate IDs or reconnects must not duplicate a publication: task 1 persistence/recovery tests.
- Focus changes or stuck modifiers must stop input: task 2 native self-test and local UI test.
- Unicode, emoji, newline text must survive unchanged: tasks 1 and 3 normalization and local typing tests.
- Untrusted origins or unauthenticated local callers must be rejected: task 1 HTTP/WebSocket integration tests.
- Wrong account/target and pre-existing drafts must never be overwritten: task 3 fixture-driven content-script tests.

### Task 1: Durable local command broker

Files: package.json, helper/jobs.mjs, helper/server.mjs, helper/native.mjs, tests/jobs.test.mjs, tests/server.test.mjs.

Interfaces: normalizeJob(input) returns canonical {id,action,url,text,mode}; JobStore.add/get/list/claim/update persist state. createServer({dataDir,port,native}) returns server and shutdown. HTTP POST /jobs, GET /jobs, GET /jobs/:id, POST /control; WebSocket /extension authenticates first message and supports request/reply RPC with unique request IDs.

- [ ] Write failing tests for command validation, idempotency, interrupted-job recovery, denied origins/auth, pairing, and one active job.
- [ ] Implement store and broker; validate extension RPCs against the active job and state.
- [ ] Run node --test tests/jobs.test.mjs tests/server.test.mjs; expect all pass.

### Task 2: Windows keyboard input

Files: native/KeyboardHost.cs, scripts/build.ps1, scripts/start.ps1, tests/native.test.mjs.

Interfaces: JSON-lines {id,op:'arm',marker}, {id,op:'key',text}, {id,op:'disarm'} return {id,ok,result,error}; native wrapper serializes requests. Only an armed Chrome foreground window with the job's unique title marker can receive input.

- [ ] Write tests for refusing input while disarmed and invalid Unicode/key payloads; implement self-test mode with a local WinForms editor.
- [ ] Implement SendInput keyboard pairs, foreground checks, held-modifier checks, Escape stop, and bounded request sizes.
- [ ] Build with installed csc.exe; run automated native guard tests and native self-test; expect exact text and focus-loss rejection.

### Task 3: Extension workflow and interface

Files: extension/manifest.json, extension/background.js, extension/content.js, extension/commands.js, extension/panel.html, extension/panel.js, extension/panel.css, tests/content.test.mjs.

Interfaces: content messages prepare/guard/read/publish/verify/cleanup scoped to a job marker; worker receives broker jobs, prepares X, requests one native key at a time, verifies text, records submitting before click, and reports verified result or needs-attention.

- [ ] Write fixture-based tests for command parsing, account/target checks, nonempty-draft refusal, and readback normalization.
- [ ] Implement extension, panel pairing, command entry, job history, pause/resume, stop, draft mode, and typing speed.
- [ ] Run all tests and syntax-check extension files; test panel and local editor flow in browser where available.

### Task 4: Packaging and final verification

Files: README.md, .gitignore, examples/send-post.ps1, scripts/package.ps1, docs/verification.md.

- [ ] Document pairing, local-only bot access, install/start, focus requirements, recovery, token storage and retention.
- [ ] Create an extension ZIP and helper launcher; run npm test, native build/self-test, and package checks.
- [ ] Obtain fresh whole-project review; correct important findings and rerun affected tests.

## Execution rulings and progress

- User approved design and directed immediate implementation with "gogogo"; no additional planning approval requested.
- Workspace is a new non-Git directory. Implement in place; no commits/worktree or destructive cleanup.
- Use Node for transport/persistence plus installed C# compiler for SendInput; avoids installing an SDK. This is the approved Windows-helper approach with a smaller build prerequisite.
- Store development runtime files under ignored .runtime here; installed usage defaults to LocalAppData/TypedPostX.
