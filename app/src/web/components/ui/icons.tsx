import type { ReactNode } from "react";

export type IconName =
  | "review"
  | "activity"
  | "insights"
  | "rules"
  | "plus"
  | "trash"
  | "archive"
  | "keep"
  | "check-question"
  | "shield"
  | "spark"
  | "spark-off"
  | "close"
  | "chevron-down"
  | "external"
  | "refresh"
  | "pause"
  | "play"
  | "more"
  | "menu"
  | "arrow-left"
  | "info"
  | "warning"
  | "error"
  | "success"
  | "history"
  | "eye-off"
  | "megaphone"
  | "star"
  | "person"
  | "list"
  | "clock"
  | "paperclip"
  | "receipt"
  | "alert"
  | "flag"
  | "question"
  | "lock"
  | "copy"
  | "check"
  | "minus";

const CIRCLE = <circle cx="8" cy="8" r="5.75" />;
const TICK = <path d="m5.5 8 1.8 1.8 3.2-3.6" />;
const QMARK = <path d="M6.5 6.5a1.5 1.5 0 1 1 2.1 1.4c-.4.2-.6.5-.6.9v.4M8 11h.01" />;
const STAR4 = <path d="M8 1.5 9.4 6.6 14.5 8 9.4 9.4 8 14.5 6.6 9.4 1.5 8 6.6 6.6z" />;
const TRIANGLE = (
  <>
    <path d="M8 2.5 14 13H2z" />
    <path d="M8 6.5v3M8 11.2h.01" />
  </>
);

const PATHS: Record<IconName, ReactNode> = {
  review: (
    <>
      <path d="M2.5 9.5h3l1 2h3l1-2h3" />
      <path d="M3.5 3.5h9l1.5 6v3a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-3z" />
    </>
  ),
  activity: <path d="M1.5 8h3l2-5 3 10 2-5h3" />,
  insights: <path d="M3 13V8M8 13V3M13 13V6" />,
  rules: (
    <>
      <path d="M2.5 4.5h11M2.5 11.5h11" />
      <circle cx="6" cy="4.5" r="1.5" />
      <circle cx="10" cy="11.5" r="1.5" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  trash: <path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.6" />,
  archive: (
    <>
      <rect x="2" y="3" width="12" height="3" rx="1" />
      <path d="M3 6v6.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6M6.5 9h3" />
    </>
  ),
  keep: (
    <>
      {CIRCLE}
      {TICK}
    </>
  ),
  "check-question": (
    <>
      {CIRCLE}
      {QMARK}
    </>
  ),
  shield: <path d="M8 2 3 4v4c0 3 2.2 5.2 5 6 2.8-.8 5-3 5-6V4z" />,
  spark: STAR4,
  "spark-off": (
    <>
      {STAR4}
      <path d="m2.5 2.5 11 11" />
    </>
  ),
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  "chevron-down": <path d="m4 6 4 4 4-4" />,
  external: (
    <path d="M9 2.5h4.5V7M13.5 2.5l-6 6M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />
  ),
  refresh: <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />,
  pause: <path d="M6 3.5v9M10 3.5v9" />,
  play: <path d="m5 3.5 7.5 4.5L5 12.5z" />,
  more: <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth={2.4} />,
  menu: <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />,
  "arrow-left": <path d="M13 8H3M7 4 3 8l4 4" />,
  info: (
    <>
      {CIRCLE}
      <path d="M8 7.5V11M8 5h.01" />
    </>
  ),
  warning: TRIANGLE,
  error: (
    <>
      <path d="M5.5 2h5L14 5.5v5L10.5 14h-5L2 10.5v-5z" />
      <path d="M8 5v3.5M8 10.8h.01" />
    </>
  ),
  success: (
    <>
      {CIRCLE}
      {TICK}
    </>
  ),
  history: (
    <>
      <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v3h3" />
      <path d="M8 5v3l2 1.5" />
    </>
  ),
  "eye-off": (
    <>
      <path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z" />
      <circle cx="8" cy="8" r="1.8" />
      <path d="m2.5 2.5 11 11" />
    </>
  ),
  megaphone: <path d="M2.5 6.5v3h2l5 3v-9l-5 3zM12 6a2.5 2.5 0 0 1 0 4M4.5 9.5l.8 3.5" />,
  star: <path d="m8 2 1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3l-3.7 2 .8-4.1L2 6.3l4.2-.5z" />,
  person: (
    <>
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3 13.5c.6-2.6 2.6-4 5-4s4.4 1.4 5 4" />
    </>
  ),
  list: <path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8M2.5 4.5h.01M2.5 8h.01M2.5 11.5h.01" />,
  clock: (
    <>
      {CIRCLE}
      <path d="M8 4.5V8l2.5 1.5" />
    </>
  ),
  paperclip: (
    <path d="m13 7.5-5.2 5.2a3 3 0 0 1-4.3-4.3l5.6-5.6a2 2 0 0 1 2.9 2.9l-5.5 5.5a1 1 0 0 1-1.4-1.4L10 4.9" />
  ),
  receipt: (
    <>
      <path d="M3.5 2h9v12l-1.8-1.2L9 14l-1.5-1.2L6 14l-1.7-1.2L3.5 14z" />
      <path d="M6 5.5h4M6 8h4" />
    </>
  ),
  alert: TRIANGLE,
  flag: <path d="M3.5 14V2.5M3.5 3h8l-1.5 3 1.5 3h-8" />,
  question: (
    <>
      {CIRCLE}
      {QMARK}
    </>
  ),
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>
  ),
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
      <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </>
  ),
  check: <path d="m3.5 8.2 3 3 6-6.7" />,
  minus: <path d="M4 8h8" />,
};

export interface IconProps {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string | undefined;
  /** When set, the icon is announced (role img); otherwise it is aria-hidden. */
  label?: string | undefined;
}

export function Icon({ name, size = 16, strokeWidth = 1.5, className, label }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className ?? ""}`}
      focusable="false"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {PATHS[name]}
    </svg>
  );
}
