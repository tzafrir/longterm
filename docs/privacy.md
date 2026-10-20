---
title: Privacy Policy — Longterm
---

# Privacy Policy

**Longterm** · Effective October 20, 2026

## Nothing leaves your machine

Longterm is a Claude Code plugin: Claude keeps a plan, a list of steps or a note in a pane beside your session, and edits it as the work moves. It runs entirely inside Claude Code on your machine.

- **It collects nothing.** No analytics, telemetry, tracking or crash reporting.
- **It sends nothing.** The plugin makes no network requests. It has no server, and nothing it handles is sent to its author or to anyone else.
- **It shares nothing.** There is no data to sell, rent or hand to third parties.

## What it keeps, and where

- **The snippets Claude keeps for you:** each one's number, title, markdown body, when it was kept and last changed, and the id of the session it belongs to.
- They live in the session's own state, and in the plugin's own store: a JSON file under your Claude Code configuration directory, keyed by project folder, so a resumed session gets its snippets back and a new session can bring an earlier one here.
- A snippet leaves the store when you or Claude remove it. An earlier session's snippet that nobody changed for `keepDays` (3 days by default) is dropped.

## What reaches the conversation

Snippets are part of your conversation with Claude: Claude wrote them, and it reads them back when it lists them, or when you press **Bring here** on an earlier one, which sends it with your next prompt. Claude Code keeps them in the session's transcript on your machine, like anything Claude writes.

The plugin also adds to the conversation the four tools Claude uses to keep, edit, remove and list snippets, and a few lines at the end of the system prompt telling Claude when to keep one. It reads the session's id and project folder only to keep snippets apart in its store, and puts neither in a prompt. It answers only calls to its own four tools.

## Claude Code itself

This policy covers only this plugin. Claude Code, and the model it talks to, handle your data under Anthropic's own terms and privacy policy, whether or not the plugin is installed.

## Changes

If this policy changes, the new version will be posted on this page with a new effective date. The history of every change is public in the [repository](https://github.com/tzafrir/longterm/commits/main/docs/privacy.md).
