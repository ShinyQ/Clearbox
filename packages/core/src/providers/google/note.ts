import { CLEARBOX_NOTE_HEADER, CLEARBOX_NOTE_NAME, CLEARBOX_NOTE_SENDER } from "../../reminder/reminder.ts";
import type { InboxNote } from "../provider.ts";

/** Header values never carry a line break (no header injection), whatever the caller passes. */
const oneLine = (value: string): string => value.replace(/[\r\n]+/g, " ").trim();

/** RFC 5322 date in UTC, for example "Sun, 18 Oct 2026 02:00:00 +0000". */
export function rfc5322Date(ms: number): string {
  return new Date(ms).toUTCString().replace(/GMT$/, "+0000");
}

/** The RFC 5322 message for Gmail `messages.insert` (contracts 12.8): plain text, CRLF line endings. */
export function buildGmailNoteMime(note: InboxNote): string {
  const headers = [
    `From: ${CLEARBOX_NOTE_NAME} <${CLEARBOX_NOTE_SENDER}>`,
    `To: <${oneLine(note.to)}>`,
    `Subject: ${oneLine(note.subject)}`,
    `Date: ${rfc5322Date(note.sentAt)}`,
    `Message-ID: <reminder-${String(note.sentAt)}@clearbox.invalid>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "Auto-Submitted: auto-generated",
    `${CLEARBOX_NOTE_HEADER}: weekly-reminder`,
  ];
  const body = note.text.replace(/\r\n|\r|\n/g, "\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

/** base64url (RFC 4648 section 5, no padding) of the UTF-8 bytes, as the Gmail `raw` field expects. */
export function base64UrlUtf8(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
