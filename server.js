const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const rooms = {};

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ─── Super TTT Logic ──────────────────────────────────────────────

function freshGame() {
  return {
    cells: Array.from({ length: 9 }, () => Array(9).fill(null)),
    miniWinner: Array(9).fill(null),
    gameWinner: null,
    turn: 0,
    activeBoard: null
  };
}

const WINS = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];

function checkMiniWinner(cells) {
  for (const [a,b,c] of WINS) {
    if (cells[a] !== null && cells[a] === cells[b] && cells[a] === cells[c]) return cells[a];
  }
  if (cells.every(c => c !== null)) return 'draw';
  return null;
}

function checkBigWinner(miniWinner) {
  for (const [a,b,c] of WINS) {
    if (miniWinner[a] !== null && miniWinner[a] !== 'draw' &&
        miniWinner[a] === miniWinner[b] && miniWinner[a] === miniWinner[c]) return miniWinner[a];
  }
  if (miniWinner.every(m => m !== null)) return 'draw';
  return null;
}

function applyMove(game, bi, ci) {
  if (game.gameWinner) return false;
  if (game.miniWinner[bi] !== null) return false;
  if (game.cells[bi][ci] !== null) return false;
  if (game.activeBoard !== null && game.activeBoard !== bi) return false;

  game.cells[bi][ci] = game.turn;

  const mw = checkMiniWinner(game.cells[bi]);
  if (mw !== null) game.miniWinner[bi] = mw;

  const gw = checkBigWinner(game.miniWinner);
  if (gw !== null) {
    game.gameWinner = gw;
  }

  if (!game.gameWinner) {
    game.activeBoard = (game.miniWinner[ci] !== null) ? null : ci;
    game.turn = 1 - game.turn;
  }

  return true;
}

// ─── HTTP ─────────────────────────────────────────────────────────

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

// ─── WebSocket ────────────────────────────────────────────────────

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
      rooms[code] = { players: [ws], game: freshGame() };
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
      broadcast(room, { type: 'start', game: room.game });
    }

    else if (msg.type === 'move') {
      const room = rooms[ws.roomCode];
      if (!room) return;
      if (room.game.turn !== ws.playerIndex) return;
      const ok = applyMove(room.game, msg.bi, msg.ci);
      if (!ok) return;
      broadcast(room, { type: 'update', game: room.game });
    }

    else if (msg.type === 'rematch') {
      const room = rooms[ws.roomCode];
      if (!room) return;
      room.rematch = (room.rematch || 0) + 1;
      if (room.rematch >= 2) {
        room.game = freshGame();
        room.rematch = 0;
        broadcast(room, { type: 'start', game: room.game });
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

server.listen(PORT, () => console.log(`Super Tic-Tac-Toe running at http://localhost:${PORT}`));
