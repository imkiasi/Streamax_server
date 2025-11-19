// Streamax N9M raw data collector with console hex output
// Usage: node streamax.js
// Listens on TCP/UDP 5556

const net = require('node:net');
const dgram = require('node:dgram');
const fs = require('node:fs');
const path = require('node:path');

const PORT_TCP = 5556;
const PORT_UDP = 5556;
const LOG_DIR = path.join(__dirname, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

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

function logPacket(prefix, rinfo, buf) {
    const base = `${prefix}_${ts()}_${String(rinfo.address).replace(/[:.]/g, '-')}_${rinfo.port}`;
    const hexFile = path.join(LOG_DIR, `${base}.hex`);
    fs.writeFileSync(hexFile, toHex(buf) + '\n', { flag: 'a' });

    console.log(`\n[${prefix.toUpperCase()}] From ${rinfo.address}:${rinfo.port}`);
    console.log(`[${prefix.toUpperCase()}] Bytes: ${buf.length}`);
    console.log(`[${prefix.toUpperCase()}] HEX:\n${toHex(buf)}`);
    console.log(`[${prefix.toUpperCase()}] ASCII:\n${toAscii(buf)}\n`);
}

// TCP listener
const tcpServer = net.createServer((socket) => {
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`[TCP] CONNECT ${peer}`);

    socket.on('data', (chunk) => {
        logPacket('tcp', { address: socket.remoteAddress, port: socket.remotePort }, chunk);
    });

    socket.on('close', () => console.log(`[TCP] CLOSE ${peer}`));
    socket.on('error', (e) => console.error(`[TCP] ERROR ${peer} ${e.message}`));
});

tcpServer.listen(PORT_TCP, '0.0.0.0', () => {
    console.log(`[TCP] Listening on 0.0.0.0:${PORT_TCP}`);
    console.log(`[INFO] Logs will land in ${LOG_DIR}`);
});

// UDP listener (optional)
const udp = dgram.createSocket('udp4');
udp.on('message', (msg, rinfo) => logPacket('udp', rinfo, msg));
udp.on('error', (e) => console.error(`[UDP] ERROR ${e.message}`));
udp.bind(PORT_UDP, '0.0.0.0', () => {
    console.log(`[UDP] Listening on 0.0.0.0:${PORT_UDP}`);
});
