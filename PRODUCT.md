# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is the owner of the deployment: one technically capable person running their own private Clearbox instance against their own Gmail and Outlook accounts. They use it on **desktop**, in a **weekly 5 to 10 minute cleanup session**, to reduce inbox clutter without risking the loss of anything important. Other self-hosters are developers who clone the public repo and deploy their own instance; they are the same persona in a different mailbox.

## Product Purpose

Clearbox pre-sorts every inbox email into delete, archive, keep, or unsure, explains why, and executes only what the owner approves. Success means the owner clears hundreds of emails in a few minutes with near-zero regret: delete precision at or above 98%, and every action reversible.

## Positioning

The AI does the sorting before the owner arrives. The owner's job is to skim and confirm, in bulk, not to read and decide email by email. Suggestions are grouped by sender and carry calibrated confidence and concrete reasons, and every decision the owner makes teaches the system. Nothing is ever deleted without approval, and "delete" means a recoverable move to trash.

## Operating Context

- A weekly ritual on a desktop browser with a mouse and keyboard.
- One deployment can connect several mailboxes (for example two Gmail and one Outlook account).
- New mail is sorted in the background (each caught-up account is checked every 30 minutes; the backlog is processed one page per minute), so a session starts with a ready queue.
- The owner may also open Gmail or Outlook in another tab to inspect a specific message.

## Capabilities and Constraints

- Actions: delete (move to trash), archive, keep, unsure. Never permanent delete.
- Each suggestion has a confidence value and up to three human-readable reasons. The model returns no prose rationale; reasons come from signals.
- Bulk approval by sender group; per-item override; undo for 24 hours.
- Guardrails (starred, replied threads, known correspondents, receipts, attachments) cap what can be suggested.
- Emails are shown as plain text (subject, sender, date, snippet). HTML email bodies are never rendered.
- Single owner per deployment, protected by Cloudflare Access.
- Runs on Cloudflare Workers Free; the inbox backlog is processed gradually (about 13k emails per day during the first backfill, about 6.8k per day sustained).
- Terminology: "suggestion", "sender group", "confidence", "reasons", "guardrail", "Clean up".

## Brand Commitments

- Name: **Clearbox**.
- The user asked for a modern design and an AI experience that feels easy: one big "Clean up" moment where the AI has already pre-sorted everything and the owner skims and confirms in bulk.
- Visual direction (chosen 2026-10-15): **the category standard, executed at full craft.** A clean, light, modern productivity interface that sits alongside **Linear, Superhuman, and the Vercel dashboard**; their craft level is the bar.
- No colored left or top edge stripes on rows, cards, or panels. Selection and emphasis use background tint, weight, or an icon instead.

## Evidence on Hand

No real users, testimonials, benchmarks, or screenshots exist yet. Mockups must use synthetic senders and subjects. Do not fabricate accuracy claims beyond the spec targets (98% delete precision target).

## Product Principles

1. **The AI prepares, the human confirms.** The owner should never face an unsorted list.
2. **Trust through evidence.** Every suggestion shows confidence and concrete reasons; uncertainty is shown, not hidden.
3. **Safe by default.** Nothing irreversible; anything uncertain falls to keep or unsure.
4. **Bulk over one-by-one.** Group by sender; one decision should clear many emails.
5. **Every decision teaches.** Overrides visibly improve future suggestions.

## Accessibility & Inclusion

Full keyboard operation for triage (approve, override, next group) and WCAG 2.2 AA contrast. Destructive actions must be distinguishable by more than color alone.
