import { envKey } from "./config.js";

/**
 * Telegram notifications via the free public Bot API (no third-party service).
 * Setup: see README "Telegram notifications" — needs TELEGRAM_BOT_TOKEN and
 * TELEGRAM_ALERT_CHAT_ID in the environment; absent both, alerts are skipped
 * silently so the bot keeps running on hosts without notification support.
 */

const API_BASE = "https://api.telegram.org";

export function hasTelegramCredentials(): boolean {
  return Boolean(
    process.env[envKey("telegram", "bot_token")] && process.env[envKey("telegram", "alert_chat_id")],
  );
}

export async function telegramAlert(text: string, silentOk = true): Promise<void> {
  const token = process.env[envKey("telegram", "bot_token")];
  const chatId = process.env[envKey("telegram", "alert_chat_id")];
  if (!token || !chatId) return;
  try {
    const res = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_notification: silentOk }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[telegram] alert failed ${res.status}: ${body.slice(0, 300)}`);
    }
  } catch (err) {
    console.error(`[telegram] alert error: ${(err as Error).message}`);
  }
}

/** One-time helper: list chat IDs that recently messaged the bot (for TELEGRAM_ALERT_CHAT_ID). */
export async function telegramDiscoverChatIds(): Promise<void> {
  const token = process.env[envKey("telegram", "bot_token")];
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  const res = await fetch(`${API_BASE}/bot${token}/getUpdates`);
  if (!res.ok) throw new Error(`getUpdates failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as {
    result: { message?: { chat?: { id?: number | string; type?: string; username?: string } } }[];
  };
  const seen = new Map<string, string>();
  for (const u of data.result ?? []) {
    const chat = u.message?.chat;
    if (!chat) continue;
    seen.set(String(chat.id), `${chat.type}${chat.username ? ` @${chat.username}` : ""}`);
  }
  if (seen.size === 0) {
    console.log("No chats found. Open Telegram, find your bot, send it any message (e.g. hello), then run this again.");
    return;
  }
  for (const [id, info] of seen) console.log(`TELEGRAM_ALERT_CHAT_ID=${id}   // ${info}`);
  console.log("Found chat(s) above. Copy TELEGRAM_ALERT_CHAT_ID=<id> into your .env / Botkeep env vars.");
}
