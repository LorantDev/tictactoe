const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// In-memory rooms only — no persistence
const rooms = {};

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); res.end('Error'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.playerIndex = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'create') {
      let code;
      do { code = generateCode(); } while (rooms[code]);
      rooms[code] = { players: [ws], board: Array(9).fill(null), turn: 0, started: false };
      ws.roomCode = code;
      ws.playerIndex = 0;
      ws.send(JSON.stringify({ type: 'created', code }));
    }

    else if (msg.type === 'join') {
      const code = (msg.code || '').toUpperCase().trim();
      const room = rooms[code];
      if (!room) { ws.send(JSON.stringify({ type: 'error', msg: 'Room not found.' })); return; }
      if (room.players.length >= 2) { ws.send(JSON.stringify({ type: 'error', msg: 'Room is full.' })); return; }
      room.players.push(ws);
      ws.roomCode = code;
      ws.playerIndex = 1;
      ws.send(JSON.stringify({ type: 'joined', code }));
      // Start game
      room.started = true;
      broadcast(room, { type: 'start', board: room.board, turn: room.turn });
    }

    else if (msg.type === 'move') {
      const room = rooms[ws.roomCode];
      if (!room || !room.started) return;
      if (room.turn !== ws.playerIndex) return;
      const idx = msg.index;
      if (idx < 0 || idx > 8 || room.board[idx] !== null) return;
      room.board[idx] = ws.playerIndex;
      const winner = checkWinner(room.board);
      const draw = !winner && room.board.every(c => c !== null);
      room.turn = 1 - room.turn;
      broadcast(room, { type: 'update', board: room.board, turn: room.turn, winner, draw });
    }

    else if (msg.type === 'rematch') {
      const room = rooms[ws.roomCode];
      if (!room) return;
      if (!room.rematch) room.rematch = 0;
      room.rematch++;
      if (room.rematch >= 2) {
        room.board = Array(9).fill(null);
        room.turn = 0;
        room.rematch = 0;
        broadcast(room, { type: 'start', board: room.board, turn: room.turn });
      } else {
        broadcast(room, { type: 'rematch_waiting' });
      }
    }
  });

  ws.on('close', () => {
    const room = rooms[ws.roomCode];
    if (!room) return;
    broadcast(room, { type: 'opponent_left' });
    delete rooms[ws.roomCode];
  });
});

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  room.players.forEach(p => { if (p.readyState === 1) p.send(data); });
}

const WINS = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
function checkWinner(board) {
  for (const [a,b,c] of WINS) {
    if (board[a] !== null && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  return null;
}

server.listen(PORT, () => console.log(`Tic-Tac-Toe running at http://localhost:${PORT}`));
