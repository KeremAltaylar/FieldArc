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
  const ready = new Promise((res, rej) => {
    ws.addEventListener("open", () => res());
    ws.addEventListener("error", () => rej(new Error("could not open the DevTools socket")));
  });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) { reject(new Error(msg.error.message)); } else { resolve(msg.result); }
      return;
    }
    listeners.forEach((fn) => fn(msg));
  });
  return {
    ready,
    on: (fn) => listeners.push(fn),
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => ws.close()
  };
}
