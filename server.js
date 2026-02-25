const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const rooms = {};

function generateCode() {
  // 4-digit numeric code, zero-padded
  return String(Math.floor(Math.random() * 10000)).padStart(4, '0');
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
      rooms[code] = { players: [ws, null], game: freshGame(), holdTimer: null };
      ws.roomCode = code;
      ws.playerIndex = 0;
      ws.send(JSON.stringify({ type: 'created', code }));
    }

    else if (msg.type === 'join') {
      const code = (msg.code || '').trim();
      const room = rooms[code];
      if (!room) { ws.send(JSON.stringify({ type: 'error', msg: 'Room not found.' })); return; }

      // Find a vacant slot (null or disconnected)
      let slot = -1;
      for (let i = 0; i < 2; i++) {
        const p = room.players[i];
        if (p === null || p.readyState === 3 /* CLOSED */) { slot = i; break; }
      }
      if (slot === -1) { ws.send(JSON.stringify({ type: 'error', msg: 'Room is full.' })); return; }

      // Cancel hold timer if running
      if (room.holdTimer) { clearTimeout(room.holdTimer); room.holdTimer = null; }

      room.players[slot] = ws;
      ws.roomCode = code;
      ws.playerIndex = slot;

      const isResume = room.game.cells.some(b => b.some(c => c !== null));
      ws.send(JSON.stringify({ type: 'joined', code, playerIndex: slot }));

      if (isResume) {
        // Game already in progress — tell everyone to resume
        broadcast(room, { type: 'start', game: room.game });
      } else if (room.players.filter(p => p && p.readyState === 1).length === 2) {
        // Fresh game, both players now present
        broadcast(room, { type: 'start', game: room.game });
      }
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
    const code = ws.roomCode;
    const room = rooms[code];
    if (!room) return;

    // Mark slot as closed
    const idx = room.players.indexOf(ws);
    if (idx !== -1) room.players[idx] = null;

    // If no players left at all, delete immediately
    const anyAlive = room.players.some(p => p && p.readyState === 1);
    if (!anyAlive && room.players.every(p => p === null)) {
      delete rooms[code];
      return;
    }

    // Notify remaining player and hold room for 5 minutes
    broadcast(room, { type: 'opponent_left' });
    if (room.holdTimer) clearTimeout(room.holdTimer);
    room.holdTimer = setTimeout(() => {
      delete rooms[code];
      console.log('Room', code, 'expired after 5 min hold');
    }, 5 * 60 * 1000);
  });
});

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  room.players.forEach(p => { if (p.readyState === 1) p.send(data); });
}

server.listen(PORT, () => console.log(`Super Tic-Tac-Toe running at http://localhost:${PORT}`));
