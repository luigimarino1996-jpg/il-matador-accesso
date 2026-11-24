import { getStore } from "@netlify/blobs";
import { createHash, randomBytes } from "node:crypto";

export const config = { path: ["/api/join", "/api/telegram", "/api/setup", "/api/config"] };

const env = (key) => process.env[key] ?? "";
const db = () => getStore({ name: "tracker", consistency: "strong" });
const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");
// Derived from the bot token, so there is no extra secret to configure.
const webhookSecret = () => sha256(`webhook:${env("TELEGRAM_BOT_TOKEN")}`);
// Extra pixels: EXTRA_PIXEL_ID and EXTRA_ACCESS_TOKEN hold comma-separated lists, paired by position.
const extraPixels = () => {
  const tokens = env("EXTRA_ACCESS_TOKEN").split(",").map((t) => t.trim());
  return env("EXTRA_PIXEL_ID").split(",").map((id) => id.trim())
    .map((id, i) => ({ pixel: id, token: tokens[i] || "" }))
    .filter((p) => /^\d{10,20}$/.test(p.pixel));
};
const clean = (value, max = 300) => (typeof value === "string" ? value.slice(0, max) : "");

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export default async (req, context) => {
  const { pathname } = new URL(req.url);
  if (pathname === "/api/join") return join(req, context);
  // The Pixel ID is public by nature; the access token never leaves the server.
  if (pathname === "/api/config") {
    return json({
      pixelId: env("META_PIXEL_ID"),
      clickEvent: env("CLICK_EVENT_NAME"),
      clarityId: env("CLARITY_ID"),
      // Second pixel, browser only: gets PageView and the click event, not Subscribe.
      extraPixelIds: extraPixels().map((p) => p.pixel),
    });
  }
  if (pathname === "/api/telegram") return telegram(req);
  if (pathname === "/api/setup") return setup(req);
  return json({ error: "not_found" }, 404);
};

async function tg(method, payload = {}) {
  const res = await fetch(`https://api.telegram.org/bot${env("TELEGRAM_BOT_TOKEN")}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description ?? res.status}`);
  return data.result;
}

// The channel is the first one where the bot is made admin (or TELEGRAM_CHANNEL_ID if set).
async function getChannel() {
  if (env("TELEGRAM_CHANNEL_ID")) return { id: env("TELEGRAM_CHANNEL_ID"), title: "" };
  return db().get("config/channel", { type: "json" });
}

// ── /api/join ── called by the landing: saves the click, returns a one-time invite link
async function join(req, context) {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const body = await req.json().catch(() => ({}));

  const channel = await getChannel();
  if (!channel) return json({ error: "channel_not_configured" }, 503);

  const clickId = randomBytes(12).toString("hex");
  let invite;
  try {
    invite = await tg("createChatInviteLink", {
      chat_id: channel.id,
      name: clickId,
      creates_join_request: true,
      expire_date: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
    });
  } catch (err) {
    console.error(err);
    return json({ error: "invite_failed" }, 502);
  }

  const click = {
    ts: new Date().toISOString(),
    url: clean(body.url, 1000),
    fbp: clean(body.fbp),
    fbc: clean(body.fbc, 600),
    ip: context?.ip ?? "",
    ua: clean(req.headers.get("user-agent") ?? "", 500),
  };
  await db().setJSON(`click/${clickId}`, click);

  // Optional event on the button click (CLICK_EVENT_NAME, e.g. Lead). The landing fires the
  // same event in the browser with the same id, so Meta keeps one and drops the other.
  const clickEvent = env("CLICK_EVENT_NAME");
  if (clickEvent) {
    const eventId = /^[\w-]{8,64}$/.test(body.event_id ?? "") ? body.event_id : `click-${clickId}`;
    const sending = sendMetaEvent({ eventName: clickEvent, eventId, click, label: `clic ${clickId}` })
      .catch((err) => console.error(err));
    // Don't make the visitor wait for Meta before opening Telegram.
    if (context?.waitUntil) context.waitUntil(sending);
    else await sending;
  }
  return json({ link: invite.invite_link });
}

// ── /api/telegram ── webhook: when someone joins, send Subscribe to Meta
async function telegram(req) {
  if (req.headers.get("x-telegram-bot-api-secret-token") !== webhookSecret()) {
    return json({ error: "forbidden" }, 403);
  }
  const update = await req.json().catch(() => ({}));
  try {
    log("notifica", describe(update));
    if (update.my_chat_member) await rememberChannel(update.my_chat_member);
    if (update.chat_join_request) await handleJoinRequest(update.chat_join_request);
    if (update.chat_member) await handleJoin(update.chat_member);
  } catch (err) {
    console.error(err); // still answer 200, or Telegram retries the same update forever
  }
  return json({ ok: true });
}

// Short summary of a Telegram update for the logs (no message content).
function describe(update) {
  const kind = Object.keys(update).find((k) => k !== "update_id") ?? "?";
  const e = update[kind] ?? {};
  return JSON.stringify({
    tipo: kind,
    chat: e.chat?.id,
    utente: e.from?.id ?? e.new_chat_member?.user?.id,
    da: e.old_chat_member?.status,
    a: e.new_chat_member?.status,
    link: e.invite_link?.name ?? (e.invite_link ? "(senza nome)" : undefined),
    via_richiesta: e.via_join_request,
  });
}

async function rememberChannel(event) {
  if (event.chat.type !== "channel") return;
  if (event.new_chat_member?.status !== "administrator") return;
  if (await getChannel()) return; // first channel wins
  await db().setJSON("config/channel", { id: event.chat.id, title: event.chat.title ?? "" });
}

// Every decision is logged, so the Netlify function logs show why an event was or wasn't sent.
const log = (...parts) => console.log("[tracker]", ...parts);

const isClickId = (name) => /^[0-9a-f]{24}$/.test(name ?? "");

// Join request through a landing link: approve it and send the event. The link stays valid for 7 days.
async function handleJoinRequest(event) {
  const channel = await getChannel();
  if (!channel || String(event.chat.id) !== String(channel.id)) return;

  const clickId = event.invite_link?.name;
  const userId = event.from.id;
  if (!isClickId(clickId)) {
    log(`richiesta di ${userId}: link non della landing ("${clickId ?? "nessun nome"}"), ignorata`);
    return;
  }

  // Only links created by this project: another bot in the same channel handles its own.
  if (!(await db().get(`click/${clickId}`, { type: "json" }))) {
    log(`richiesta di ${userId}: link ${clickId} non creato da questo progetto, ignorata`);
    return;
  }

  try {
    await tg("approveChatJoinRequest", { chat_id: event.chat.id, user_id: userId });
    log(`richiesta di ${userId} approvata (link ${clickId})`);
  } catch (err) {
    // Someone else (another bot or an admin) approved first: the person still joined through our link.
    if (!String(err.message).includes("USER_ALREADY_PARTICIPANT")) throw err;
    log(`richiesta di ${userId} già approvata da altri (link ${clickId}), invio comunque l'evento`);
  }
  await recordSubscribe({ clickId, userId, eventTime: event.date });
}

// Member updates: covers joins approved by someone else before our bot saw the request.
// recordSubscribe drops the duplicate when the request was already handled above.
async function handleJoin(event) {
  const channel = await getChannel();
  if (!channel || String(event.chat.id) !== String(channel.id)) return;

  const wasOutside = ["left", "kicked"].includes(event.old_chat_member?.status);
  const isInside = ["member", "administrator", "creator"].includes(event.new_chat_member?.status);
  if (!wasOutside || !isInside) return;

  const clickId = event.invite_link?.name;
  if (!isClickId(clickId)) {
    log(`utente ${event.new_chat_member.user.id} entrato senza un link della landing`);
    return;
  }
  log(`utente ${event.new_chat_member.user.id} entrato dal link ${clickId}`);
  await recordSubscribe({ clickId, userId: event.new_chat_member.user.id, eventTime: event.date });
}

async function recordSubscribe({ clickId, userId, eventTime }) {
  const click = await db().get(`click/${clickId}`, { type: "json" });
  if (!click) {
    log(`utente ${userId}: clic ${clickId} non trovato, nessun evento`);
    return;
  }
  // No per-person limit across links, but one join through one link counts once:
  // Telegram can report the same join twice (join request + member update).
  const sentKey = `sent/${clickId}-${userId}`;
  if (await db().get(sentKey, { type: "json" })) {
    log(`utente ${userId}: evento per il link ${clickId} già inviato, salto il doppione`);
    return;
  }
  await db().setJSON(sentKey, { ts: new Date().toISOString() });
  await sendSubscribe({ click, clickId, userId, eventTime });
}

async function sendSubscribe({ click, clickId, userId, eventTime }) {
  await sendMetaEvent({
    eventName: env("META_EVENT_NAME") || "Subscribe",
    eventId: `sub-${clickId}-${userId}`,
    eventTime,
    click,
    externalId: userId,
    label: `utente ${userId}`,
  });
}

async function sendMetaEvent({ eventName, eventId, eventTime, click, externalId, label }) {
  const userData = {};
  if (externalId) userData.external_id = [sha256(externalId)];
  if (click.ip) userData.client_ip_address = click.ip;
  if (click.ua) userData.client_user_agent = click.ua;
  if (click.fbp) userData.fbp = click.fbp;
  if (click.fbc) userData.fbc = click.fbc;

  const body = {
    data: [{
      event_name: eventName,
      event_time: eventTime ?? Math.floor(Date.now() / 1000),
      event_id: eventId,
      action_source: "website",
      event_source_url: click.url || undefined,
      user_data: userData,
    }],
  };
  if (env("META_TEST_EVENT_CODE")) body.test_event_code = env("META_TEST_EVENT_CODE");

  // Main pixel, plus every extra pixel that has its own token.
  const targets = [{ pixel: env("META_PIXEL_ID"), token: env("META_ACCESS_TOKEN") }];
  for (const extra of extraPixels()) if (extra.token) targets.push(extra);
  const results = await Promise.allSettled(targets.map((t) => postToMeta(t, body, eventName, label)));
  // Only a failure on the main pixel is an error; extra pixels are best effort (logged).
  if (results[0].status === "rejected") throw results[0].reason;
}

async function postToMeta({ pixel, token }, body, eventName, label) {
  const version = env("META_API_VERSION") || "v24.0";
  const res = await fetch(
    `https://graph.facebook.com/${version}/${pixel}/events?access_token=${encodeURIComponent(token)}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const result = await res.json().catch(() => ({}));
  log(`Meta ${eventName} per ${label} (pixel ${pixel}): HTTP ${res.status}`,
    JSON.stringify({ events_received: result.events_received, fbtrace_id: result.fbtrace_id, error: result.error?.message }));
  if (!res.ok) throw new Error(`Meta ${pixel}: ${result.error?.message ?? res.status}`);
}

// ── /api/setup ── open in the browser: connects the bot and tells you what is missing
async function setup(req) {
  const missing = ["TELEGRAM_BOT_TOKEN", "META_PIXEL_ID", "META_ACCESS_TOKEN"].filter((k) => !env(k));
  if (missing.length) {
    return json({ ok: false, problema: `Variabili mancanti su Netlify: ${missing.join(", ")}` }, 500);
  }
  try {
    const origin = new URL(req.url).origin;
    await tg("setWebhook", {
      url: `${origin}/api/telegram`,
      secret_token: webhookSecret(),
      allowed_updates: ["chat_member", "my_chat_member", "chat_join_request"],
    });
    const me = await tg("getMe");
    const channel = await getChannel();
    if (!channel) {
      return json({
        ok: false,
        bot: `@${me.username}`,
        prossimoPasso: `Aggiungi @${me.username} al canale come amministratore (permesso "Invitare utenti tramite link"), poi ricarica questa pagina.`,
      });
    }
    const member = await tg("getChatMember", { chat_id: channel.id, user_id: me.id });
    const ready = member.status === "administrator" && member.can_invite_users === true;
    return json({
      ok: ready,
      bot: `@${me.username}`,
      canale: channel.title || String(channel.id),
      prossimoPasso: ready
        ? "Tutto pronto. Incolla lo snippet nella landing."
        : 'Dai al bot il permesso "Invitare utenti tramite link" nel canale, poi ricarica.',
    });
  } catch (err) {
    return json({ ok: false, problema: err.message }, 500);
  }
}
