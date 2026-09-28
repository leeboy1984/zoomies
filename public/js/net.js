// WebSocket connection to the server, with automatic reconnection.
// Messages: {type:"snapshot", sessions}, {type:"session", session}, {type:"remove", id}.

export function connect({ onSnapshot, onSession, onRemove, onStatus }) {
  let delay = 500;
  let ws = null;

  const open = () => {
    ws = new WebSocket(`ws://${location.host}/ws`);
    ws.addEventListener("open", () => {
      delay = 500;
      onStatus?.("connected");
    });
    ws.addEventListener("message", (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === "snapshot") onSnapshot(msg.sessions);
      else if (msg.type === "session") onSession(msg.session);
      else if (msg.type === "remove") onRemove(msg.id);
    });
    ws.addEventListener("close", () => {
      onStatus?.("reconnecting");
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 10_000);
    });
  };
  open();
  return () => ws?.close();
}
