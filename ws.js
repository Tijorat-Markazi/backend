/* ============================================================
   TIJORAT MARKAZI — a minimal WebSocket server (RFC 6455)

   The project has no package.json and no node_modules, and adding
   `ws` would make this the first dependency. The parts of the
   protocol a chat actually needs are small enough to implement
   directly: the handshake is a SHA-1 of the client key, and frames
   are a length prefix, an optional mask and the payload.

   Supported: text frames (including continuation), ping/pong, close,
   and payloads up to 2^32 bytes. Not supported: extensions, binary
   application frames, or compression — none of which a JSON chat
   needs.
   ============================================================ */
const crypto = require("crypto");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xA };
const MAX_FRAME = 16 * 1024 * 1024;          // refuse anything larger

function accept(key) {
  return crypto.createHash("sha1").update(key + GUID).digest("base64");
}

/** Build a server→client frame. Server frames are never masked. */
function frame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload || ""), "utf8");
  const len = data.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeUInt32BE(0, 2);
    head.writeUInt32BE(len, 6);
  }
  head[0] = 0x80 | opcode;                   // FIN + opcode
  return Buffer.concat([head, data]);
}

/**
 * One connection. Emits through the callbacks given to attach().
 */
class Conn {
  constructor(socket, server) {
    this.socket = socket;
    this.server = server;
    this.buf = Buffer.alloc(0);
    this.frags = [];                          // continuation frames
    this.fragOp = null;
    this.alive = true;
    this.data = {};                           // whatever the app hangs on it
  }
  send(obj) {
    if (!this.alive) return;
    try { this.socket.write(frame(OP.TEXT, JSON.stringify(obj))); }
    catch (e) { this.close(); }
  }
  ping() { if (this.alive) { try { this.socket.write(frame(OP.PING, "")); } catch (e) { this.close(); } } }
  close(code) {
    if (!this.alive) return;
    this.alive = false;
    try {
      const p = Buffer.alloc(2); p.writeUInt16BE(code || 1000, 0);
      this.socket.write(frame(OP.CLOSE, p));
      this.socket.end();
    } catch (e) { try { this.socket.destroy(); } catch (e2) {} }
    this.server._drop(this);
  }

  /** Pull as many complete frames out of the buffer as we can. */
  _read(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < off + 2) return;
        len = b.readUInt16BE(off); off += 2;
      } else if (len === 127) {
        if (b.length < off + 8) return;
        const hi = b.readUInt32BE(off), lo = b.readUInt32BE(off + 4);
        if (hi !== 0) return this.close(1009);      // > 4 GB: refuse
        len = lo; off += 8;
      }
      if (len > MAX_FRAME) return this.close(1009);
      // every client→server frame MUST be masked
      if (!masked) return this.close(1002);
      if (b.length < off + 4 + len) return;
      const mask = b.slice(off, off + 4); off += 4;
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = b[off + i] ^ mask[i & 3];
      this.buf = b.slice(off + len);

      if (opcode === OP.CLOSE) return this.close(1000);
      if (opcode === OP.PING) { try { this.socket.write(frame(OP.PONG, payload)); } catch (e) {} continue; }
      if (opcode === OP.PONG) { this.pong = Date.now(); continue; }

      if (opcode === OP.CONT) {
        this.frags.push(payload);
      } else {
        this.fragOp = opcode;
        this.frags = [payload];
      }
      if (!fin) continue;
      const full = Buffer.concat(this.frags);
      this.frags = [];
      if (this.fragOp === OP.TEXT) {
        let msg = null;
        try { msg = JSON.parse(full.toString("utf8")); } catch (e) { continue; }
        this.server._message(this, msg);
      }
    }
  }
}

/**
 * Attach a WebSocket endpoint to an existing http/https server.
 *
 * @param {http.Server} httpServer
 * @param {object} opts
 * @param {string} opts.path              only upgrade on this path
 * @param {function} opts.onOpen(conn)
 * @param {function} opts.onMessage(conn, msg)
 * @param {function} opts.onClose(conn)
 */
function attach(httpServer, opts) {
  const conns = new Set();
  const server = {
    conns,
    _drop(c) { conns.delete(c); if (opts.onClose) { try { opts.onClose(c); } catch (e) {} } },
    _message(c, m) { if (opts.onMessage) { try { opts.onMessage(c, m); } catch (e) {} } },
    /** Send to every connection the predicate accepts. */
    broadcast(obj, where) {
      conns.forEach(function (c) { if (!where || where(c)) c.send(obj); });
    }
  };

  httpServer.on("upgrade", (req, socket) => {
    if (opts.path && req.url.split("?")[0] !== opts.path) { socket.destroy(); return; }
    const key = req.headers["sec-websocket-key"];
    if (String(req.headers.upgrade || "").toLowerCase() !== "websocket" || !key) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n"); socket.destroy(); return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " + accept(key) + "\r\n\r\n"
    );
    socket.setNoDelay(true);
    const conn = new Conn(socket, server);
    conns.add(conn);
    socket.on("data", (d) => { try { conn._read(d); } catch (e) { conn.close(1011); } });
    socket.on("error", () => conn.close());
    socket.on("close", () => { conn.alive = false; server._drop(conn); });
    if (opts.onOpen) { try { opts.onOpen(conn); } catch (e) {} }
  });

  /* A dead TCP socket can sit open for a long time; ping every 30s and
     drop anything that has not answered in 90. */
  setInterval(() => {
    const now = Date.now();
    conns.forEach((c) => {
      if (c.pong && now - c.pong > 90000) return c.close(1001);
      c.ping();
    });
  }, 30000).unref();

  return server;
}

module.exports = { attach, frame, accept, OP };
