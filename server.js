import express from "express";
import http from "http";
import { Server } from "socket.io";
import crypto from "crypto";

const app = express();
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" } // 배포 후 프론트 도메인으로 제한해도 됨
});

const rooms = new Map();
// rooms.get(roomId) = { hostSocketId, hostPassHash, participants:[{socketId,name}] }

function sha256(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { hostSocketId: null, hostPassHash: null, participants: [] });
  }
  return rooms.get(roomId);
}

function pickUniqueIndices(total, k) {
  const arr = Array.from({ length: total }, (_, i) => i);
  for (let i = total - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, Math.min(k, total));
}

// ✅ 방 생성(호스트 비번 설정) + 초대링크 생성
app.post("/api/create-room", (req, res) => {
  const { roomId, hostPassword } = req.body || {};
  if (!roomId || !hostPassword) return res.status(400).json({ ok: false, error: "roomId/hostPassword 필요" });

  const room = getRoom(roomId);
  room.hostPassHash = sha256(String(hostPassword));

  const FRONT_BASE = process.env.FRONT_BASE || "https://example.github.io/wat-race-front";
  const inviteLink = `${FRONT_BASE}/?room=${encodeURIComponent(roomId)}`;

  res.json({ ok: true, roomId, inviteLink });
});

io.on("connection", (socket) => {
  socket.on("joinRoom", ({ roomId, name, asHost, hostPassword }) => {
    if (!roomId || !name) return;

    const room = getRoom(roomId);

    // 호스트 입장 체크
    if (asHost) {
      if (room.hostSocketId) return socket.emit("errorMsg", "이미 호스트가 있습니다.");
      if (!room.hostPassHash) return socket.emit("errorMsg", "호스트 비밀번호가 아직 설정되지 않았습니다.");
      if (sha256(String(hostPassword || "")) !== room.hostPassHash) {
        return socket.emit("errorMsg", "호스트 비밀번호가 틀렸습니다.");
      }
      room.hostSocketId = socket.id;
    }

    socket.join(roomId);

    const exists = room.participants.some(p => p.name === name);
    const safeName = exists ? `${name}-${socket.id.slice(-4)}` : name;
    room.participants.push({ socketId: socket.id, name: safeName });

    io.to(roomId).emit("participantsUpdate", {
      participants: room.participants.map(p => p.name),
      hostOnline: !!room.hostSocketId
    });

    socket.emit("joined", { you: safeName, isHost: room.hostSocketId === socket.id });
  });

  // ✅ Top7 추첨
  socket.on("drawTop7", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    if (room.hostSocketId !== socket.id) return socket.emit("errorMsg", "호스트만 추첨할 수 있습니다.");
    const total = room.participants.length;
    if (total === 0) return socket.emit("errorMsg", "참가자가 없습니다.");

    const seed = crypto.randomBytes(4).readUInt32LE(0);
    const picked = pickUniqueIndices(total, 7); // 1~7등 인덱스
    const winners = picked.map((idx, r) => ({
      rank: r + 1,
      index: idx,
      name: room.participants[idx].name
    }));

    io.to(roomId).emit("drawTop7Result", {
      seed,
      participants: room.participants.map(p => p.name),
      winners,
      at: new Date().toISOString()
    });
  });

  socket.on("disconnect", () => {
    for (const [roomId, room] of rooms.entries()) {
      room.participants = room.participants.filter(p => p.socketId !== socket.id);
      if (room.hostSocketId === socket.id) room.hostSocketId = null;

      io.to(roomId).emit("participantsUpdate", {
        participants: room.participants.map(p => p.name),
        hostOnline: !!room.hostSocketId
      });

      if (room.participants.length === 0 && !room.hostSocketId) rooms.delete(roomId);
    }
  });
});

app.get("/", (req, res) => res.send("OK"));
server.listen(process.env.PORT || 3000, () => console.log("Server running"));
