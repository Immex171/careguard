/**
 * Notification dispatcher — channels: console, Slack, Email, SMS
 *
 * Email  : Resend (RESEND_API_KEY) or Postmark (POSTMARK_API_KEY)
 * SMS    : Twilio (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER)
 * Slack  : SLACK_WEBHOOK_URL
 *
 * Per-channel opt-in is controlled via notification preferences in policy.
 * Notifications must never crash the caller.
 */

import { logger } from "./logger.ts";

export type NotificationLevel = "info" | "warning" | "critical";

export type NotificationChannel = "console" | "slack" | "email" | "sms";

export interface NotificationPreferences {
  email: boolean;
  sms: boolean;
  slack: boolean;
  emailAddress?: string;
  phoneNumber?: string;
}

export interface Notification {
  level: NotificationLevel;
  title: string;
  description: string;
  context?: Record<string, unknown>;
  channels?: NotificationChannel[];
}

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const POSTMARK_API_KEY = process.env.POSTMARK_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;

const DEFAULT_FROM_EMAIL = process.env.NOTIFICATION_FROM_EMAIL || "notifications@careguard.ai";

const ICONS: Record<NotificationLevel, string> = {
  info: "ℹ️",
  warning: "⚠️",
  critical: "🚨",
};

export async function notify(n: Notification): Promise<void> {
  const line = `${ICONS[n.level]} [${n.level.toUpperCase()}] ${n.title} — ${n.description}`;
  if (n.level === "critical" || n.level === "warning") {
    logger.warn({ title: n.title, description: n.description }, line);
  } else {
    logger.info({ title: n.title, description: n.description }, line);
  }

  const channels = n.channels ?? ["console", "slack"];

  await Promise.allSettled([
    channels.includes("slack") && SLACK_WEBHOOK_URL ? deliverSlack(n) : Promise.resolve(),
    channels.includes("email") ? deliverEmail(n) : Promise.resolve(),
    channels.includes("sms") ? deliverSms(n) : Promise.resolve(),
  ]);
}

async function deliverSlack(n: Notification): Promise<void> {
  if (!SLACK_WEBHOOK_URL) return;
  try {
    const ctx = n.context ? `\n\n\`\`\`${JSON.stringify(n.context, null, 2)}\`\`\`` : "";
    await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `${ICONS[n.level]} *${n.title}*\n${n.description}${ctx}`,
      }),
    });
  } catch (err: any) {
    logger.warn({ err: err?.message ?? err }, "failed to deliver Slack notification");
  }
}

async function deliverEmail(n: Notification): Promise<void> {
  const to = n.context?.emailAddress as string | undefined;
  if (!to) {
    logger.warn({ title: n.title }, "email notification skipped — no recipient address");
    return;
  }

  if (RESEND_API_KEY) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: DEFAULT_FROM_EMAIL,
          to,
          subject: `[${n.level.toUpperCase()}] ${n.title}`,
          text: `${n.description}\n\n${n.context ? JSON.stringify(n.context, null, 2) : ""}`,
        }),
      });
      return;
    } catch (err: any) {
      logger.warn({ err: err?.message ?? err }, "Resend email failed");
    }
  }

  if (POSTMARK_API_KEY) {
    try {
      await fetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: {
          "X-Postmark-Server-Token": POSTMARK_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          From: DEFAULT_FROM_EMAIL,
          To: to,
          Subject: `[${n.level.toUpperCase()}] ${n.title}`,
          TextBody: `${n.description}\n\n${n.context ? JSON.stringify(n.context, null, 2) : ""}`,
        }),
      });
    } catch (err: any) {
      logger.warn({ err: err?.message ?? err }, "Postmark email failed");
    }
  }
}

async function deliverSms(n: Notification): Promise<void> {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) return;

  const to = n.context?.phoneNumber as string | undefined;
  if (!to) {
    logger.warn({ title: n.title }, "SMS notification skipped — no recipient number");
    return;
  }

  try {
    const auth = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
    await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          "Authorization": `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          To: to,
          From: TWILIO_FROM_NUMBER,
          Body: `[${n.level.toUpperCase()}] ${n.title}: ${n.description}`,
        }).toString(),
      }
    );
  } catch (err: any) {
    logger.warn({ err: err?.message ?? err }, "Twilio SMS failed");
  }
}
