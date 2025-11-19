const net = require("net");
const dgram = require('dgram');
const crypto = require("crypto");
const fs = require('fs');
const path = require('node:path');

const devices = {};

const PORT_TCP = 5556;
const PORT_UDP = 5556;
const LOG_DIR = path.join(__dirname, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

function dt() {
  return new Date().toISOString().replace(/T.*/g, '');
}

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// Convert to readable hex view
function toHex(buf) {
  return buf.toString('hex').match(/.{1,2}/g)?.join(' ') || '';
}

// Convert to printable ASCII
function toAscii(buf) {
  return buf.toString('ascii').replace(/[^\x20-\x7E]/g, '.');
}


function generateSO() {
  return crypto.randomBytes(8).toString("hex").toUpperCase(); // 16 chars
}

function getCarNum(sessionId) {
  return devices[sessionId]?.carnum || "";
}

function logPacket(sessionId, packet) {
  if (!sessionId) return;

  const base = `${getCarNum(sessionId)}_${dt()}`;
  const logFile = path.join(LOG_DIR, `${base}.log`);
  fs.writeFileSync(logFile, `[${ts()}] ` + JSON.stringify(packet) + '\n', { flag: 'a' });
}

// --- Packet construction/parsing (same layout you described) ---
function buildPacket(payloadObj, payloadType = 0, ssrc = 1) {
  const payloadBuf = Buffer.from(JSON.stringify(payloadObj), 'utf8');

  const header = Buffer.alloc(12);
  const version = 0, padding = 0, marker = 0, csrcCount = 0;
  const firstByte = (version << 6) | (padding << 5) | (marker << 4) | csrcCount;
  let off = 0;
  header.writeUInt8(firstByte, off++);          // 1
  header.writeUInt8(payloadType, off++);        // 2
  header.writeUInt16BE(ssrc, off); off += 2;    // 3-4
  header.writeUInt32BE(payloadBuf.length, off); off += 4; // 5-8 payload len (TCP)
  header.writeUInt32BE(0, off); off += 4;       // 9-12 reserve

  return Buffer.concat([header, payloadBuf]);
}


// --- Packet parser from your structure ---
function parsePacket(buffer) {
  let offset = 0;

  if (buffer.length < 12) return null; // not enough data for header

  const firstByte = buffer.readUInt8(offset++);
  const version = (firstByte >> 6) & 0x03;
  const padding = (firstByte >> 5) & 0x01;
  const marker = (firstByte >> 4) & 0x01;
  const csrcCount = firstByte & 0x0F;

  const payloadType = buffer.readUInt8(offset++);
  const ssrc = buffer.readUInt16BE(offset);
  offset += 2;

  const payloadLen = buffer.readUInt32BE(offset);
  offset += 4;

  const reserve = buffer.readUInt32BE(offset);
  offset += 4;

  const csrcList = [];
  // for (let i = 0; i < csrcCount; i++) {
  //   if (offset + 4 > buffer.length) return null;
  //   const csrc = buffer.readUInt32BE(offset);
  //   csrcList.push(csrc);
  //   offset += 4;
  // }

  const totalLen = offset + payloadLen;
  if (buffer.length < totalLen) {
    // Wait for more data
    return null;
  }

  const payloadBuffer = buffer.subarray(offset, totalLen);

  let payload;
  if (payloadType === 0 || payloadType === 1) {
    try {
      payload = JSON.parse(payloadBuffer.toString("utf8").trim());
    } catch {
      payload = payloadBuffer.toString("utf8").trim();
    }
  } else if (payloadType === 2) {
    payload = payloadBuffer; // binary H264
  } else {
    payload = payloadBuffer;
  }

  return {
    version,
    padding,
    marker,
    csrcCount,
    payloadType,
    ssrc,
    payloadLen,
    reserve,
    csrcList,
    payload,
    totalLength: totalLen
  };
}

const handleMessagePacket = async (socket, packet, sessionId) => {
  const msg = packet.payload;
  let session = msg.SESSION || sessionId || '';

  let respJson = null;
  switch (msg.MODULE) {
    case "CERTIFICATE":
      {
        respJson = {
          MODULE: "CERTIFICATE",
          OPERATION: msg.OPERATION,
          RESPONSE: {},
          SESSION: session,
        }
        if (msg.OPERATION == "CONNECT") {
          respJson.RESPONSE = {
            SO: generateSO(),
            ERRORCODE: 0,
            ERRORCAUSE: 'SUCCESS',
            PRO: msg.PARAMETER?.PRO || "1.0.5",
            MASKCMD: 1
          };

          devices[session] = {
            session: session,
            dsno: msg.PARAMETER.DSNO,
            carnum: msg.PARAMETER.CARNUM,
            channel: msg.PARAMETER.CHANNEL,
            devname: msg.PARAMETER.DEVNAME,
            devclass: msg.PARAMETER.DEVCLASS,
            devtype: msg.PARAMETER.DEVTYPE,
            net: msg.PARAMETER.NET,
            pro: msg.PARAMETER.PRO,
          };
        } else if (msg.OPERATION == "KEEPALIVE") {
          respJson.RESPONSE = {};
        } else if (msg.OPERATION == "CREATESTREAM") {
          respJson.RESPONSE = {
            ERRORCODE: 0,
            ERRORCAUSE: 'SUCCESS',
          };
        }
        break;
      }
    case "MEDIASTREAMMODEL":
      {
        if (msg.OPERATION == "MEDIATASKSTART") {
          respJson = {
            MODULE: "MEDIASTREAMMODEL",
            OPERATION: "REQUESTSTREAM",
            PARAMETER: {
              STREAMTYPE: -1,
              STREAMNAME: msg.PARAMETER.STREAMNAME,
              CSRC: msg.PARAMETER.CSRC,
              SSRC: msg.PARAMETER.SSRC,
            },
            SESSION: session,
          }
        }
        break;
      }
    default:
      break;
  }

  if (respJson) {
    const responsePacket = buildPacket(respJson, packet.payloadType, packet.ssrc);
    socket.write(responsePacket);
  }

  if (msg.MODULE != "EVEM") {
    console.log(`📦 [${getCarNum(session)}] Payload:`, JSON.stringify(msg));
  }
  logPacket(session, packet);

  if (msg.MODULE == "CERTIFICATE" && msg.OPERATION == "CONNECT") {
    // if connected new device request stream
    const requestPacket = buildPacket({
      MODULE: "MEDIASTREAMMODEL",
      OPERATION: "REQUESTALIVEVIDEO",
      PARAMETER: {
        CSRC: "",
        SSRC: 0,
        STREAMNAME: "1",
        STEAMTYPE: 0,
        CHANNEL: 1, //80000000,
        AUDIOVALID: 0,
        IPANDPORT: "91.238.164.100:5556",
        // IPANDPORT: "",
        FRAMECOUNT: 10,
        FRAMEMODE: 0,
      },
      SESSION: msg.SESSION || '',
    }, 0, 0);

    setTimeout(() => {
      console.log('========= sent video stream request =============');
      socket.write(requestPacket);
    }, 1000);
  }

  return session;
}

const handleStreamPacket = async (socket, packet, sessionId) => {

  console.log(`🎥 [${getCarNum(sessionId)}] Received video payload (${packet.payload.length} bytes)`);

  logPacket(sessionId, packet);
}

// --- TCP Server ---
const server = net.createServer((socket) => {
  console.log(`📡 Device connected: ${socket.remoteAddress}:${socket.remotePort}`);

  let buffer = Buffer.alloc(0);
  let sessionId = "";

  socket.on("data", (data) => {
    buffer = Buffer.concat([buffer, data]);

    while (buffer.length > 0) {
      const packet = parsePacket(buffer);
      if (!packet) break; // incomplete packet, wait for more data

      if (packet.payloadType === 0 || packet.payloadType === 1) {
        handleMessagePacket(socket, packet, sessionId).then(result => sessionId = result);
      } else if (packet.payloadType === 2) {
        handleStreamPacket(socket, packet, sessionId);
      } else {

        if (packet.payloadType != 22) {
          console.log(`✅ [${getCarNum(sessionId)}] Sent:`,
            JSON.stringify({
              version: packet.version,
              payloadType: packet.payloadType,
              csrcCount: packet.csrcCount,
              ssrc: packet.ssrc,
              payloadLen: packet.payloadLen,
              totalLength: packet.totalLength,
            })
          );
        }

      }

      // Remove processed data
      buffer = buffer.subarray(packet.totalLength);
    }
  });

  socket.on("end", () => {
    console.log(`❌ [${getCarNum(sessionId)}] Device disconnected: ${socket.remoteAddress}:${socket.remotePort}`);
  });

  socket.on("error", (err) => {
    console.error(`[${getCarNum(sessionId)}] Socket error:`, err.message);
  });
});

server.listen(PORT_TCP, () => {
  console.log(`[TCP] Listening on 0.0.0.0:${PORT_TCP}`);
});



// UDP listener (optional)
const udp = dgram.createSocket('udp4');
udp.on('message', (msg, rinfo) => console.log('[UDP]', rinfo, msg));
udp.on('error', (e) => console.error(`[UDP] ERROR ${e.message}`));
udp.bind(PORT_UDP, '0.0.0.0', () => {
  console.log(`[UDP] Listening on 0.0.0.0:${PORT_UDP}`);
});
