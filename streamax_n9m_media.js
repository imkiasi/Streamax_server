// Streamax N9M media receiver - configured for your NVR ports
// Control TCP: 5556
// Media UDP: 6111
// Optional Register UDP: 6222
// CommonJS (node >=16)

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('child_process');

const CONTROL_PORT = 5556;          // TCP control (REGISTER SERVER)
const MEDIA_UDP_PORT = 6111;        // UDP media (MEDIA SERVER)
const REGISTER_UDP_PORT = 6222;     // optional heartbeat
const VPS_IP = '91.238.164.100';    // your VPS public IP
const HLS_DIR = path.join('/home/ubuntu', 'n9m_hls');
const PROTO_VERSION = '1.0.6';

fs.mkdirSync(HLS_DIR, { recursive: true });

// Start ffmpeg to receive RTP on UDP 6111 and output HLS
let ffmpegProc = null;
function startFfmpeg() {
    if (ffmpegProc) return;
    const args = [
        '-fflags', 'nobuffer',
        '-flags', 'low_delay',
        '-an',
        '-i', `udp://0.0.0.0:${MEDIA_UDP_PORT}?fifo_size=500000&overrun_nonfatal=1`,
        '-c:v', 'copy',
        '-hls_time', '2',
        '-hls_list_size', '6',
        '-hls_flags', 'delete_segments+append_list',
        '-f', 'hls',
        path.join(HLS_DIR, 'index.m3u8')
    ];
    ffmpegProc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    ffmpegProc.stderr.on('data', d => process.stdout.write(`[ffmpeg] ${d}`));
    ffmpegProc.on('exit', c => {
        console.log(`[ffmpeg] exited ${c}`);
        ffmpegProc = null;
    });
    console.log(`[MEDIA] ffmpeg started — listening UDP ${MEDIA_UDP_PORT} → ${HLS_DIR}/index.m3u8`);
}

// Basic helpers
function hexdump(buf) {
    let out = '';
    for (let i = 0; i < buf.length; i += 16) {
        const chunk = buf.slice(i, i + 16);
        const hex = chunk.toString('hex').match(/.{1,2}/g)?.join(' ') ?? '';
        const ascii = chunk.toString('ascii').replace(/[^\x20-\x7E]/g, '.');
        out += `${i.toString(16).padStart(8, '0')}  ${hex.padEnd(47, ' ')} |${ascii}|\n`;
    }
    return out;
}

// N9M unified header parsing
function parseN9M(buf) {
    if (buf.length < 12) return null;
    const b0 = buf[0];
    const version = (b0 >> 6) & 0b11;
    const payloadType = buf[1];
    const ssrc = buf.readUInt32BE(2);
    const payloadLen = buf.readUInt32BE(6);
    const headerLen = 12;
    // if (buf.length < headerLen + payloadLen) return null;
    console.log(`=====================`, ssrc);
    if (buf.length == 12) return null;
    return {
        type: 'N9M',
        header: { version, payloadType, ssrc, payloadLen, headerLen },
        payload: buf.slice(headerLen, headerLen + payloadLen),
        rest: buf.slice(headerLen + payloadLen)
    };
}
function buildSignalFrame(ssrc, obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(12);

  // --- version & payloadType ---
  // first byte: version (2 bits = 2) << 6 = 0x80
  // second byte: 0 for SIGNAL
  header[0] = (2 << 6);
  header[1] = 0;

  // --- SSRC (4 bytes) ---
  header.writeUInt32BE(ssrc >>> 0, 2);

  // --- Payload length (4 bytes) ---
  header.writeUInt32BE(body.length, 6);

  // --- Reserved (2 bytes) ---
  header.writeUInt16BE(0, 10);

  const frame = Buffer.concat([header, body]);
  console.log(`[DEBUG] TX header: ${header.toString('hex')} length=${body.length}`);
  return frame;
}

const SESSIONS = new Map();
function md5Hex(s) { return crypto.createHash('md5').update(s).digest('hex'); }

// Respond to certificate handshake
function handleCert(socket, ssrc, obj) {
    if (!obj || obj.MODULE !== 'CERTIFICATE' || !obj.OPERATION) {
        console.warn('[WARN] Invalid CERTIFICATE frame:', obj);
        return;
    }

    if (obj.MODULE === 'CERTIFICATE' && obj.OPERATION === 'CONNECT') {
        const protoVer = obj.PARAMETER?.PRO || '1.0.6';
        const session = obj.SESSION;
      
        const resp = {
          MODULE: 'CERTIFICATE',
          OPERATION: 'CONNECT',
          RESPONSE: {
            SO: { type: 'string', value: crypto.randomBytes(8).toString('hex') },
            PRO: { type: 'string', value: protoVer },
            ERRORCODE: { type: 'integer', value: 0 },
            ERRORCAUSE: { type: 'string', value: 'OK' }
          },
          SESSION: session
        };
      
        const frame = buildSignalFrame(ssrc, resp);
        socket.write(frame);
        console.log(`[TX] Sent CERTIFICATE.CONNECT -> ${socket.remoteAddress}:${socket.remotePort}`);
      }


    const op = obj.OPERATION;
    const session = obj.SESSION || obj.session || null;
    const protoVer = obj.PARAMETER?.PRO || PROTO_VERSION;

    const reply = (operation, response) => {
        const msg = {
            MODULE: 'CERTIFICATE',
            OPERATION: operation,
            RESPONSE: response,
            SESSION: session
        };
        const temp = buildSignalFrame(ssrc, msg);
        console.log("actual JSON string i send back, ", temp.toString());
        socket.write(buildSignalFrame(ssrc, msg));
        console.log(`[TX] Sent CERTIFICATE.${operation} -> ${socket.remoteAddress}:${socket.remotePort}`);
    };

    switch (op) {
        case 'CONNECT':
            reply('CONNECT', {
                SO: { type: 'string', value: crypto.randomBytes(8).toString('hex') },
                PRO: { type: 'string', value: protoVer },
                ERRORCODE: { type: 'integer', value: 0 },
                ERRORCAUSE: { type: 'string', value: 'OK' }
            });
            console.log('[CERT] CONNECT -> replied with SO + OK');
            break;

        case 'VERIFY':
            reply('VERIFY', {
                RETURN: { type: 'boolean', value: true },
                ERRORCODE: { type: 'integer', value: 0 },
                ERRORCAUSE: { type: 'string', value: 'OK' }
            });
            console.log('[CERT] VERIFY -> OK');
            break;

        case 'LOGIN':
            reply('LOGIN', {
                RETURN: { type: 'boolean', value: true },
                ERRORCODE: { type: 'integer', value: 0 },
                ERRORCAUSE: { type: 'string', value: 'OK' }
            });
            console.log('[CERT] LOGIN -> OK');
            setTimeout(() => requestMedia(socket, ssrc, session), 1000);
            break;

        case 'KEEPALIVE':
            reply('KEEPALIVE', { RETURN: { type: 'boolean', value: true } });
            console.log('[CERT] KEEPALIVE -> OK');
            break;

        default:
            console.warn('[WARN] Unknown CERTIFICATE operation:', op);
    }
}


// TCP server (control)
net.createServer((socket) => {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10000);
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`[TCP] CONNECT ${peer}`);
    let rx = Buffer.alloc(0);
    let ssrc;

    socket.on('data', (chunk) => {
        rx = Buffer.concat([rx, chunk]);
        console.log(`\n[RX ${peer}] ${chunk.length} bytes\n`);
        while (true) {
            const frame = parseN9M(rx);
            if (!frame) break;
            if (frame.header?.ssrc) ssrc = frame.header.ssrc;
            if (frame.header.payloadType === 0) {
                try {
                    const obj = JSON.parse(frame.payload.toString('utf8'));
                    console.log(`[SIGNAL] ${obj.MODULE}.${obj.OPERATION}`);
                    if (obj.MODULE === 'CERTIFICATE'){
                        handleCert(socket, ssrc, obj);
                    }
                    else console.log('[JSON]', obj);
                } catch (e) {
                    console.log('[WARN] Non-JSON SIGNAL', e);
                }
            } else {
                console.log(`[N9M] PT=${frame.header.payloadType} payload=${frame.payload.length} bytes`);
            }
            rx = frame.rest;
        }
    });

    socket.on('close', () => console.log(`[TCP] CLOSE ${peer}`));
    socket.on('error', (e) => console.error(`[TCP] ERROR ${peer} ${e.message}`));
}).listen(CONTROL_PORT, '0.0.0.0', () => {
    console.log(`[CTRL] Listening TCP on ${CONTROL_PORT}`);
    console.log(`[MEDIA] UDP expected on ${MEDIA_UDP_PORT}`);
    console.log(`[INFO] HLS directory: ${HLS_DIR}`);
});