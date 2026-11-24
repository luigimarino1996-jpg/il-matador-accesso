// Telegram join buttons, shared by the landings.
// On tap: a new page opens right away (so the visitor sees the button worked), the personal
// invite link is created, the click event is sent (browser + server, same id), then the new
// page goes to Telegram. If the new page can't open (some in-app browsers block it),
// Telegram opens in the same page.
//
// Usage: TGJoin.init({ buttons, getClickEvent: () => "Lead", onError: () => {...} })
(function () {
  const cookie = (name) =>
    document.cookie.split("; ").find((c) => c.startsWith(name + "="))?.split("=")[1] ?? "";
  const newEventId = () => "click-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

  // Minimal dark page with a spinner, shown in the new page while the link is created.
  const LOADING_PAGE = '<!DOCTYPE html><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Telegram</title><style>html,body{margin:0;height:100%;background:#0a0b0d;display:grid;place-items:center}' +
    'i{width:38px;height:38px;border:4px solid #2aabee33;border-top-color:#2aabee;border-radius:50%;animation:s .8s linear infinite}' +
    '@keyframes s{to{transform:rotate(360deg)}}</style><i></i>';

  function openBlankTab() {
    const tab = window.open("", "_blank");
    if (!tab) return null;
    try { tab.document.write(LOADING_PAGE); tab.document.close(); } catch { /* blocked: fine */ }
    return tab;
  }

  function init({ buttons, getClickEvent = () => "", onError = () => {} }) {
    let busy = false;

    buttons.forEach((button) => button.addEventListener("click", async (e) => {
      e.preventDefault();
      if (busy) return;
      busy = true;

      // Must happen inside the tap, otherwise the browser blocks the new page.
      const tab = openBlankTab();

      try {
        // Same id in the browser and on the server, so Meta counts the click event once.
        const eventId = newEventId();
        const clickEvent = getClickEvent();
        if (clickEvent && window.fbq) fbq("track", clickEvent, {}, { eventID: eventId });
        const fbclid = new URLSearchParams(location.search).get("fbclid");
        const res = await fetch("/api/join", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            event_id: eventId,
            url: location.href,
            fbp: cookie("_fbp"),
            fbc: cookie("_fbc") || (fbclid ? `fb.1.${Date.now()}.${fbclid}` : ""),
          }),
        });
        const data = await res.json();
        if (!data.link) throw new Error("no link");

        let opened = false;
        if (tab && !tab.closed) {
          try { tab.location.href = data.link; opened = true; } catch { opened = false; }
        }
        if (!opened) {
          location.href = data.link;
        } else {
          // Some in-app browsers return a page that never shows: if this page is still in
          // front after a moment, open Telegram here too.
          setTimeout(() => { if (!document.hidden) location.href = data.link; }, 1500);
        }
      } catch {
        if (tab && !tab.closed) tab.close();
        onError();
      } finally {
        // If the visitor comes back to this page, the buttons work again.
        setTimeout(() => { busy = false; }, 1500);
      }
    }));
  }

  window.TGJoin = { init };
})();
