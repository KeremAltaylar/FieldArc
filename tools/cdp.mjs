/* tools/cdp.mjs — the bare Chrome DevTools Protocol transport: list targets, open a session.
 *
 * Split out of tools/phone.mjs so Task 2's tools/viewports.mjs (desktop Chrome, no adb) can
 * reuse the same wire code instead of a copy of it. Nothing here knows about adb, USB, or
 * Android — it only assumes a DevTools HTTP+WebSocket endpoint is already reachable on the given
 * port, however it got there (phone.mjs forwards one over USB; a desktop Chrome launched with
 * --remote-debugging-port publishes one directly).
 *
 * Node 24 has a global WebSocket and fetch, so this needs no dependency at all.
 */

/* The page targets DevTools currently has open. Filtering to type "page" drops the browser's own
   background targets (service workers, extensions) that eval would otherwise silently hit. */
export async function targets(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!r.ok) { throw new Error("DevTools endpoint said " + r.status + " — is Chrome open?"); }
  return (await r.json()).filter((t) => t.type === "page");
}

/* One request/response over a target's WebSocket, plus any events that arrive while it is open
   — which is how a console watcher listens without a second connection. */
export function session(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  /* Events that arrive before anyone has called on() yet. A caller is not required to register
     before the socket starts delivering — send() doesn't wait on it, and Page.navigate or a
     device that's mid-load can emit before a watcher's on() call lands — so without this an
     early event is just gone, with nothing to say it happened. Drained into the first listener
     the moment one registers. */
  const early = [];

  /* A send() in flight when the socket goes away — unplugged, Chrome killed, or a plain close()
     — must not hang forever: settle every pending request instead of leaving its promise to rot
     with no resolve and no reject. Runs on both "close" and "error" since a mid-session drop can
     surface as either, and close() calls it directly so an explicit close settles the same way. */
  function settlePending(reason) {
    for (const { reject } of pending.values()) { reject(reason); }
    pending.clear();
  }
  const ready = new Promise((res, rej) => {
    ws.addEventListener("open", () => res());
    ws.addEventListener("error", () => rej(new Error("could not open the DevTools socket")));
  });
  ws.addEventListener("close", () => settlePending(new Error("DevTools socket closed")));
  ws.addEventListener("error", () => settlePending(new Error("DevTools socket error")));
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) { reject(new Error(msg.error.message)); } else { resolve(msg.result); }
      return;
    }
    if (listeners.length) { listeners.forEach((fn) => fn(msg)); } else { early.push(msg); }
  });
  return {
    ready,
    on(fn) {
      listeners.push(fn);
      if (early.length) { early.splice(0).forEach((msg) => fn(msg)); }
    },
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      settlePending(new Error("session closed"));
      ws.close();
    }
  };
}
