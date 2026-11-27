import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const data = new Map();
mock.module("@netlify/blobs", {
  namedExports: {
    getStore: () => ({
      setJSON: async (key, value) => void data.set(key, structuredClone(value)),
      get: async (key) => data.get(key) ?? null,
    }),
  },
});

Object.assign(process.env, { TELEGRAM_BOT_TOKEN: "TOKEN", META_PIXEL_ID: "999", META_ACCESS_TOKEN: "META" });
const secret = createHash("sha256").update("webhook:TOKEN").digest("hex");

const calls = [];
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push({ url: String(url), body });
  if (String(url).includes("createChatInviteLink")) return Response.json({ ok: true, result: { invite_link: "https://t.me/+abc" } });
  if (String(url).includes("getMe")) return Response.json({ ok: true, result: { id: 1, username: "mybot" } });
  if (String(url).includes("getChatMember")) return Response.json({ ok: true, result: { status: "administrator", can_invite_users: true } });
  if (String(url).includes("graph.facebook.com")) return Response.json({ events_received: 1 });
  return Response.json({ ok: true, result: true });
};
const metaCalls = () => calls.filter((c) => c.url.includes("graph.facebook.com"));

const { default: handler } = await import("../netlify/functions/tracker.mjs");
const post = (path, body, headers = {}) =>
  handler(new Request(`https://site.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "UA", ...headers },
    body: JSON.stringify(body),
  }), { ip: "1.2.3.4" });
const hook = (update, s = secret) => post("/api/telegram", update, { "x-telegram-bot-api-secret-token": s });
const joinUpdate = (userId, name, chatId = -100123) => ({
  chat_member: {
    chat: { id: chatId, type: "channel" }, date: 1794000000,
    old_chat_member: { status: "left" },
    new_chat_member: { status: "member", user: { id: userId } },
    invite_link: name ? { name } : undefined,
  },
});

test("setup before the bot is in the channel asks to add it", async () => {
  const res = await handler(new Request("https://site.test/api/setup"));
  const out = await res.json();
  assert.equal(out.ok, false);
  assert.match(out.prossimoPasso, /@mybot/);
  const hookCall = calls.find((c) => c.url.includes("setWebhook")).body;
  assert.equal(hookCall.url, "https://site.test/api/telegram");
  assert.deepEqual(hookCall.allowed_updates, ["chat_member", "my_chat_member", "chat_join_request"]);
});

test("join before the channel is known fails cleanly", async () => {
  assert.equal((await post("/api/join", {})).status, 503);
});

test("bot made admin → channel remembered, first one wins", async () => {
  const admin = (id, title) => ({ my_chat_member: { chat: { id, type: "channel", title }, new_chat_member: { status: "administrator" } } });
  await hook(admin(-100123, "Mio canale"));
  await hook(admin(-100999, "Altro"));
  assert.equal(data.get("config/channel").id, -100123);
  const out = await (await handler(new Request("https://site.test/api/setup"))).json();
  assert.equal(out.ok, true);
  assert.equal(out.canale, "Mio canale");
});

test("click → join → Subscribe sent to Meta once", async () => {
  const res = await post("/api/join", { fbp: "fb.1.1.2", fbc: "fb.1.1.xyz", url: "https://landing.test/?x=1" });
  assert.equal((await res.json()).link, "https://t.me/+abc");
  assert.equal((await (await handler(new Request("https://site.test/api/config"))).json()).pixelId, "999");
  const invite = calls.find((c) => c.url.includes("createChatInviteLink")).body;
  assert.equal(invite.chat_id, -100123);
  assert.equal(invite.creates_join_request, true);
  assert.equal(invite.member_limit, undefined);
  const days = (invite.expire_date - Date.now() / 1000) / 86400;
  assert.ok(days > 6.99 && days <= 7);
  assert.ok(invite.name.length <= 32);

  await hook(joinUpdate(7, invite.name));
  assert.equal(metaCalls().length, 1);
  assert.ok(metaCalls()[0].url.includes("/999/events"));
  const event = metaCalls()[0].body.data[0];
  assert.equal(event.event_name, "Subscribe");
  assert.equal(event.user_data.fbp, "fb.1.1.2");
  assert.equal(event.user_data.fbc, "fb.1.1.xyz");
  assert.equal(event.user_data.client_ip_address, "1.2.3.4");
  assert.equal(event.user_data.client_user_agent, "UA");

  // Every join counts, even from the same person.
  await post("/api/join", { fbp: "fb.1.1.2" });
  const second = calls.filter((c) => c.url.includes("createChatInviteLink")).at(-1).body.name;
  await hook(joinUpdate(7, second));
  assert.equal(metaCalls().length, 2);
  assert.notEqual(metaCalls()[0].body.data[0].event_id, metaCalls()[1].body.data[0].event_id);
});

test("joins not from the landing, other chats, wrong secret → nothing sent", async () => {
  const name = calls.find((c) => c.url.includes("createChatInviteLink")).body.name;
  await hook(joinUpdate(8, null));
  await hook(joinUpdate(9, name, -100555));
  assert.equal((await hook(joinUpdate(10, name), "wrong")).status, 403);
  assert.equal(metaCalls().length, 2);
});

test("join request from a landing link → approved, event sent, link kept", async () => {
  calls.length = 0;
  await post("/api/join", { fbp: "fb.1.5.6" });
  const name = calls.find((c) => c.url.includes("createChatInviteLink")).body.name;
  const request = (userId, linkName) => ({
    chat_join_request: {
      chat: { id: -100123, type: "channel" }, from: { id: userId }, date: 1794000500,
      invite_link: { name: linkName, invite_link: "https://t.me/+abc" },
    },
  });
  process.env.META_EVENT_NAME = "Lead";
  await hook(request(20, name));
  delete process.env.META_EVENT_NAME;
  const approve = calls.find((c) => c.url.includes("approveChatJoinRequest")).body;
  assert.deepEqual(approve, { chat_id: -100123, user_id: 20 });
  assert.equal(metaCalls().length, 1);
  assert.equal(metaCalls()[0].body.data[0].user_data.fbp, "fb.1.5.6");
  assert.equal(metaCalls()[0].body.data[0].event_name, "Lead");
  assert.equal(calls.some((c) => c.url.includes("revokeChatInviteLink")), false);

  // The chat_member update that follows an approval must not send a second event.
  const follow = joinUpdate(20, name); follow.chat_member.via_join_request = true;
  await hook(follow);
  assert.equal(metaCalls().length, 1);

  // If someone else approved first, the lead still counts (once).
  calls.length = 0;
  await post("/api/join", { fbp: "fb.1.7.8" });
  const name2 = calls.find((c) => c.url.includes("createChatInviteLink")).body.name;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => String(url).includes("approveChatJoinRequest")
    ? Response.json({ ok: false, description: "Bad Request: USER_ALREADY_PARTICIPANT" })
    : realFetch(url, init);
  await hook(request(30, name2));
  globalThis.fetch = realFetch;
  assert.equal(metaCalls().length, 1);
  // ...and the member update Telegram sends right after is not a second lead.
  await hook(joinUpdate(30, name2));
  assert.equal(metaCalls().length, 1);
  assert.equal(metaCalls()[0].body.data[0].user_data.fbp, "fb.1.7.8");

  // Requests through links not created by the landing are left alone.
  calls.length = 0;
  await hook(request(21, "Link manuale"));
  assert.equal(calls.length, 0);

  // Same for links created by another project's bot (valid format, unknown click).
  await hook(request(22, "0123456789abcdef01234567"));
  assert.equal(calls.length, 0);
});

test("CLICK_EVENT_NAME sends an event on the button click with the browser's id", async () => {
  process.env.CLICK_EVENT_NAME = "Lead";
  const config = await (await handler(new Request("https://site.test/api/config"))).json();
  assert.equal(config.clickEvent, "Lead");
  assert.equal(config.clarityId, "");
  assert.deepEqual(config.extraPixelIds, []);
  calls.length = 0;
  await post("/api/join", { fbp: "fb.1.9.9", event_id: "click-abc123xyz" });
  delete process.env.CLICK_EVENT_NAME;
  assert.equal(metaCalls().length, 1);
  const event = metaCalls()[0].body.data[0];
  assert.equal(event.event_name, "Lead");
  assert.equal(event.event_id, "click-abc123xyz");
  assert.equal(event.user_data.fbp, "fb.1.9.9");
  assert.equal(event.user_data.external_id, undefined);

  // Without the variable, a click sends nothing.
  calls.length = 0;
  await post("/api/join", { fbp: "fb.1.9.9" });
  assert.equal(metaCalls().length, 0);
});

test("EXTRA_PIXEL_ID + EXTRA_ACCESS_TOKEN: server events go to both pixels with the same id", async () => {
  process.env.CLICK_EVENT_NAME = "Lead";
  process.env.EXTRA_PIXEL_ID = "1446956473565497, 1714879203539607";
  process.env.EXTRA_ACCESS_TOKEN = "EXTRA,EXTRA2";
  const cfg = await (await handler(new Request("https://site.test/api/config"))).json();
  assert.deepEqual(cfg.extraPixelIds, ["1446956473565497", "1714879203539607"]);
  calls.length = 0;
  await post("/api/join", { fbp: "fb.1.2.3", event_id: "click-xyz12345" });
  const name = calls.find((c) => c.url.includes("createChatInviteLink")).body.name;
  await hook({ chat_join_request: { chat: { id: -100123, type: "channel" }, from: { id: 77 }, date: 1794000900,
    invite_link: { name, invite_link: "https://t.me/+abc" } } });
  for (const k of ["CLICK_EVENT_NAME", "EXTRA_PIXEL_ID", "EXTRA_ACCESS_TOKEN"]) delete process.env[k];
  const who = (c) => c.url.includes("/1446956473565497/") ? "extra1" : c.url.includes("/1714879203539607/") ? "extra2" : "main";
  const sent = metaCalls().map((c) => [who(c), c.body.data[0].event_name, c.body.data[0].event_id]);
  const lead = sent.filter((x) => x[1] === "Lead");
  const sub = sent.filter((x) => x[1] === "Subscribe");
  assert.deepEqual(lead.map((x) => x[0]).sort(), ["extra1", "extra2", "main"]);
  assert.equal(new Set(lead.map((x) => x[2])).size, 1);
  assert.deepEqual(sub.map((x) => x[0]).sort(), ["extra1", "extra2", "main"]);
  assert.ok(metaCalls().some((c) => c.url.includes("/1714879203539607/") && c.url.includes("access_token=EXTRA2")));
});

test("/vai: direct link redirects to a personal invite and tracks the ad click", async () => {
  process.env.CLICK_EVENT_NAME = "Lead";
  calls.length = 0;
  const res = await handler(new Request("https://site.test/vai?fbclid=AbC123", { headers: { "user-agent": "UA" } }), { ip: "5.6.7.8" });
  delete process.env.CLICK_EVENT_NAME;
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "https://t.me/+abc");
  const invite = calls.find((c) => c.url.includes("createChatInviteLink")).body;
  assert.equal(invite.creates_join_request, true);
  const ev = metaCalls()[0].body.data[0];
  assert.equal(ev.event_name, "Lead");
  assert.match(ev.user_data.fbc, /^fb\.1\.\d+\.AbC123$/);
  assert.equal(ev.user_data.client_ip_address, "5.6.7.8");
  // The join through that link is then tracked like any other.
  const stored = data.get(`click/${invite.name}`);
  assert.equal(stored.direct, true);
});
