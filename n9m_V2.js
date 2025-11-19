/**
 * Streamax N9M Transmit-Mode Server (TCP)
 * ---------------------------------------
 * - Listens on TCP 5556 (Register/Signal + Media)
 * - Negotiates live stream (CreateStream + ControlStream)
 * - Saves raw H.264 frames to ./recordings/<dsno>-ch<ssrc>.h264
 * - Broadcasts frames over WebSocket (ws://<host>:8080)
 *
 * Requirements: Node 18+
 */

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { WebSocketServer } from 'ws';

/* ============================ CONFIG ============================ */
const CONFIG = {
    tcpPort: 5556,              // MDVR connects here (Register/Signal + Media)
    wsPort: 8080,               // Browser clients subscribe here for raw H.264
    createStream: {
        vision: '1.0.5',
        devtype: 4,               // 4 = MDVR (typical)
    },
    defaultControl: {
        streamtype: 1,            // 0=sub, 1=main, 2=mobile
        audiovalid: 0,            // 0=no audio; set bitmask if enabling audio
        cmd: 1                    // 1=start/resume, 2=pause, 3=stop (varies by build)
    },
    heartbeat: {
        intervalMs: 30_000,       // server->device keepalive push (Transmit mode ~45s typical)
        timeoutMs: 120_000        // disconnect if no bytes seen for this long
    },
    storageDir: path.resolve(process.cwd(), 'recordings') // where .h264 files go
};
/* =============================================================== */

if (!fs.existsSync(CONFIG.storageDir)) fs.mkdirSync(CONFIG.storageDir, { recursive: true });

/* ============================ WS HUB ============================ */
const httpServer = http.createServer();
const wss = new WebSocketServer({ server: httpServer });
httpServer.listen(CONFIG.wsPort, () =>
    console.log(`[WS] Listening on ws://0.0.0.0:${CONFIG.wsPort}`)
);

// Simple hub keyed by device streamname/channel
const wsRooms = new Map(); // key -> Set(ws)

function wsBroadcast(key, data) {
    const set = wsRooms.get(key);
    if (!set) return;
    for (const ws of set) {
        if (ws.readyState === ws.OPEN) ws.send(data);
    }
}

wss.on('connection', (ws, req) => {
    // Client can choose room via query ?room=<key>
    const url = new URL(req.url, `http://${req.headers.host}`);
    const room = url.searchParams.get('room') || 'default';
    if (!wsRooms.has(room)) wsRooms.set(room, new Set());
    wsRooms.get(room).add(ws);
    ws.on('close', () => wsRooms.get(room)?.delete(ws));
    ws.send(Buffer.from(`CONNECTED to room=${room}`));
    console.log(`[WS] Client joined room="${room}"`);
});
/* =============================================================== */

/* ========================= N9M Helpers ========================== */
// Packet builder: RTP-like header (TCP: PAYLOAD_LEN = byte length)
function buildN9MPacket({ pt, ssrc = 0, csrcs = [], payload }) {
    const V = 2, P = 0, M = 0, CC = csrcs.length & 0x0F;
    const first = ((V & 0x03) << 6) | ((P & 0x01) << 5) | ((M & 0x01) << 4) | (CC & 0x0F);
    const header = Buffer.allocUnsafe(8);
    header[0] = first;
    header[1] = pt & 0xFF;                 // PAYLOAD TYPE
    header.writeUInt16BE(ssrc & 0xFFFF, 2);// SSRC (channel index fits)
    header.writeUInt32BE(payload.length, 4);// TCP: payload byte length
    const csrcBuf = Buffer.alloc(4 * CC);
    csrcs.forEach((id, i) => csrcBuf.writeUInt32BE(id >>> 0, i * 4));
    return Buffer.concat([header, csrcBuf, payload]);
}

// JSON SIGNAL (PT=0)
function packSignal(json) {
    return buildN9MPacket({ pt: 0, payload: Buffer.from(JSON.stringify(json), 'utf8') });
}

// Parser with sticky buffer support
function parseN9M(buffer) {
    if (buffer.length < 8) return null;
    const vpmcc = buffer[0];
    const cc = vpmcc & 0x0F;
    const pt = buffer[1];
    const ssrc = buffer.readUInt16BE(2);
    const payloadLen = buffer.readUInt32BE(4);
    const headerLen = 8 + cc * 4;
    if (buffer.length < headerLen + payloadLen) return null;
    const payload = buffer.slice(headerLen, headerLen + payloadLen);
    const rest = buffer.slice(headerLen + payloadLen);
    return { pt, ssrc, payload, rest };
}
/* =============================================================== */

/* ========================= Per-Conn State ======================= */
class N9MConnection {
    constructor(socket) {
        this.socket = socket;
        this.recvBuf = Buffer.alloc(0);
        this.lastActivity = Date.now();

        // Discovered/negotiated attributes
        this.dsno = null;                // device serial (when known)
        this.streamname = null;          // chosen stream name
        this.files = new Map();          // ssrc -> write stream
        this.wsRoomKey = null;           // room for WS broadcast (derived)

        // timers
        this.keepAliveTimer = null;
        this.idleTimer = null;

        this.installHandlers();
        this.startTimers();
    }

    log(...args) { console.log(`[N9M ${this.socket.remoteAddress}:${this.socket.remotePort}]`, ...args); }

    installHandlers() {
        this.socket.on('data', chunk => {
            this.lastActivity = Date.now();
            this.recvBuf = Buffer.concat([this.recvBuf, chunk]);
            while (true) {
                const pkt = parseN9M(this.recvBuf);
                if (!pkt) break;
                this.recvBuf = pkt.rest;
                this.handlePacket(pkt);
            }
        });

        this.socket.on('close', () => this.cleanup('socket closed'));
        this.socket.on('error', (e) => this.cleanup(`socket error: ${e.message}`));
    }

    startTimers() {
        // Server-originated keepalive (Transmit mode devices tolerate this)
        this.keepAliveTimer = setInterval(() => {
            try {
                const msg = { module: 'certificate', operation: { name: 'KeepAlive', Type: 'Request-response' } };
                this.socket.write(packSignal(msg));
            } catch { /* noop */ }
        }, CONFIG.heartbeat.intervalMs);

        // Idle timeout watchdog
        this.idleTimer = setInterval(() => {
            if (Date.now() - this.lastActivity > CONFIG.heartbeat.timeoutMs) {
                this.cleanup('idle timeout');
            }
        }, 5_000);
    }

    cleanup(reason) {
        if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
        if (this.idleTimer) clearInterval(this.idleTimer);
        for (const [ssrc, ws] of this.files.entries()) {
            try { ws.end(); } catch { }
            this.files.delete(ssrc);
        }
        try { this.socket.destroy(); } catch { }
        this.log(`closed: ${reason}`);
    }

    /* --------------- High-level Ops (SIGNAL JSON) ---------------- */
    sendCreateStream() {
        if (!this.streamname) this.streamname = `live-${Date.now()}`;
        const payload = {
            module: 'certificate',
            operation: { name: 'CreateStream', Type: 'Request-response' },
            parameter: {
                vision: CONFIG.createStream.vision,
                devtype: CONFIG.createStream.devtype,
                streamname: this.streamname,
                ipandport: '',                // same socket
                dsno: this.dsno || ''         // fill if known
            }
        };
        this.socket.write(packSignal(payload));
        this.log(`CreateStream sent (streamname="${this.streamname}", dsno="${this.dsno || ''}")`);
    }

    sendControlStart(ssrc = 1) {
        const p = {
            module: 'mediaStreamModel',
            operation: { name: 'ControlStream', Type: 'Request-response' },
            parameter: {
                csrc: '',
                pt: 2, // expect H.264 upstream
                ssrc,
                streamname: this.streamname,
                streamtype: CONFIG.defaultControl.streamtype,
                audiovalid: CONFIG.defaultControl.audiovalid,
                cmd: CONFIG.defaultControl.cmd
            }
        };
        this.socket.write(packSignal(p));
        this.log(`ControlStream(start) sent for channel=${ssrc}`);
    }

    // Optional pause/stop helpers
    sendControlStop(ssrc = 1) {
        const p = {
            module: 'mediaStreamModel',
            operation: { name: 'ControlStream', Type: 'Request-response' },
            parameter: {
                csrc: '',
                pt: 2,
                ssrc,
                streamname: this.streamname,
                streamtype: CONFIG.defaultControl.streamtype,
                audiovalid: CONFIG.defaultControl.audiovalid,
                cmd: 3 // stop (typical)
            }
        };
        this.socket.write(packSignal(p));
        this.log(`ControlStream(stop) sent for channel=${ssrc}`);
    }

    /* ------------------ Packet Demultiplexing -------------------- */
    handlePacket({ pt, ssrc, payload }) {
        switch (pt) {
            case 0: this.handleSignal(payload); break;       // SIGNAL (JSON)
            case 1: this.handleMeta(ssrc, payload); break;   // METADATA (JSON)
            case 2: this.handleH264(ssrc, payload); break;   // H.264
            case 12: /* AUDIO */ break;                      // you can add audio handling
            default:
                this.log(`Unknown PT=${pt} len=${payload.length}`);
        }
    }

    handleSignal(buf) {
        let msg = null;
        try { msg = JSON.parse(buf.toString('utf8')); }
        catch (e) { this.log('Bad SIGNAL JSON'); return; }

        const op = msg?.operation?.name || 'Unknown';
        const param = msg?.parameter || {};
        const resp = msg?.response || {};

        // Heuristics: try to capture dsno/serial/imei from early messages
        const discoveredDsno = param.dsno || resp.dsno || param.deviceid || resp.deviceid || param.imei || resp.imei;
        if (discoveredDsno && !this.dsno) {
            this.dsno = String(discoveredDsno);
            this.wsRoomKey = this.wsRoomKey || `n9m:${this.dsno}:ch1`;
            this.log(`Identified DSNO=${this.dsno}`);
        }

        this.log(`SIGNAL op=${op}`);

        // Common ops you may see:
        // - Connect / Register / KeepAlive / MediaTaskStart / MediaTaskStop ...
        if (/connect|register/i.test(op)) {
            // After initial register/connect from device, request a stream
            if (!this.streamname) this.streamname = `live-${this.dsno || Date.now()}`;
            this.sendCreateStream();
            // Start channel 1 by default; add more if needed
            this.sendControlStart(1);
        }

        if (/KeepAlive/i.test(op)) {
            // Optionally acknowledge or just note activity; we already push our own.
            // If device expects an echo object, add here.
        }

        if (/MediaTaskStart/i.test(op)) {
            this.log('Media task confirmed by device.');
        }
    }

    handleMeta(ssrc, buf) {
        try {
            const meta = JSON.parse(buf.toString('utf8'));
            this.log(`META ch=${ssrc} ->`, meta);
            // Example: { codec:"H264", width:..., height:..., fps:... }
        } catch {
            this.log('Bad META JSON');
        }
    }

    handleH264(ssrc, frame) {
        // File writer per channel
        const key = `${this.dsno || 'unknown'}-ch${ssrc}`;
        if (!this.files.has(ssrc)) {
            const filePath = path.join(CONFIG.storageDir, `${key}.h264`);
            const ws = fs.createWriteStream(filePath, { flags: 'a' });
            this.files.set(ssrc, ws);
            this.log(`Recording -> ${filePath}`);
            // Default WS room for this conn if not set:
            if (!this.wsRoomKey) this.wsRoomKey = `n9m:${this.dsno || 'unknown'}:ch${ssrc}`;
            this.log(`WS room key -> "${this.wsRoomKey}"`);
        }
        try {
            this.files.get(ssrc).write(frame);
        } catch (e) {
            this.log(`File write error: ${e.message}`);
        }
        // WS broadcast to viewers (room key chosen above)
        if (this.wsRoomKey) wsBroadcast(this.wsRoomKey, frame);
    }
}
/* =============================================================== */

/* ============================ TCP SERVER ======================== */
const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    const conn = new N9MConnection(socket);
    conn.log('incoming connection established');
});

server.listen(CONFIG.tcpPort, () => {
    console.log(`[TCP] N9M server listening on 0.0.0.0:${CONFIG.tcpPort}`);
});
/* =============================================================== */

/**
 * Notes:
 * - This server assumes the MDVR is configured to "N9M" protocol with:
 *     Register Server IP: <this machine public IP>
 *     Register TCP Port : 5556
 *     Media Server IP   : <same IP>
 *     Media TCP Port    : 5556
 *   as shown in your screenshot.
 *
 * - WebSocket preview:
 *   Connect a browser WS client to ws://<server>:8080?room=n9m:<DSNO>:ch1
 *   and feed the binary frames into an MSE player that expects Annex-B H.264.
 *
 * - To start multiple channels, call sendControlStart(2), sendControlStart(3), etc.
 *
 * - If your device/firmware expects slightly different JSON for CreateStream/ControlStream,
 *   log incoming SIGNAL packets and adjust keys inside sendCreateStream()/sendControlStart().
 *
 * - For HLS/DASH/RTMP outputs, pipe frames into ffmpeg (separate process) that reads Annex-B H.264.
 */
