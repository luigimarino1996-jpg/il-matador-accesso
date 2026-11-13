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

  await hook(joinUpdate(7, invite.name)); // re-join
  assert.equal(metaCalls().length, 1);
});

test("joins not from the landing, other chats, wrong secret → nothing sent", async () => {
  const name = calls.find((c) => c.url.includes("createChatInviteLink")).body.name;
  await hook(joinUpdate(8, null));
  await hook(joinUpdate(9, name, -100555));
  assert.equal((await hook(joinUpdate(10, name), "wrong")).status, 403);
  assert.equal(metaCalls().length, 1);
});

test("join request from a landing link → approved, Subscribe sent, link retired", async () => {
  calls.length = 0;
  await post("/api/join", { fbp: "fb.1.5.6" });
  const name = calls.find((c) => c.url.includes("createChatInviteLink")).body.name;
  const request = (userId, linkName) => ({
    chat_join_request: {
      chat: { id: -100123, type: "channel" }, from: { id: userId }, date: 1794000500,
      invite_link: { name: linkName, invite_link: "https://t.me/+abc" },
    },
  });
  await hook(request(20, name));
  const approve = calls.find((c) => c.url.includes("approveChatJoinRequest")).body;
  assert.deepEqual(approve, { chat_id: -100123, user_id: 20 });
  assert.equal(metaCalls().length, 1);
  assert.equal(metaCalls()[0].body.data[0].user_data.fbp, "fb.1.5.6");
  assert.equal(calls.find((c) => c.url.includes("revokeChatInviteLink")).body.invite_link, "https://t.me/+abc");

  // The chat_member update that follows an approval must not send a second event.
  const follow = joinUpdate(20, name); follow.chat_member.via_join_request = true;
  await hook(follow);
  assert.equal(metaCalls().length, 1);

  // Requests through links not created by the landing are left alone.
  calls.length = 0;
  await hook(request(21, "Link manuale"));
  assert.equal(calls.length, 0);

  // Same for links created by another project's bot (valid format, unknown click).
  await hook(request(22, "0123456789abcdef01234567"));
  assert.equal(calls.length, 0);
});
