const express = require("express");
const http = require("node:http");
const path = require("node:path");
const mongoose = require("mongoose");
const { Server } = require("socket.io");
const Schedule = require("./models/Schedule");

const PORT = Number(process.env.PORT) || 3000;
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URL;
const SCHEDULE_KEY = "main";
const SLOT_COUNT = 12;

const TIME_LABELS = [
  "8:00 PM",
  "8:30 PM",
  "9:00 PM",
  "9:30 PM",
  "10:00 PM",
  "10:30 PM",
  "11:00 PM",
  "11:30 PM",
  "12:00 AM",
  "12:30 AM",
  "1:00 AM",
  "1:30 AM"
];

const configuredOrigins = String(process.env.CLIENT_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) return true;

  const normalized = origin.replace(/\/$/, "");
  if (configuredOrigins.includes(normalized)) return true;

  if (/^https:\/\/[a-z0-9-]+\.github\.io$/i.test(normalized)) return true;
  if (/^https:\/\/[a-z0-9-]+\.up\.railway\.app$/i.test(normalized)) return true;
  if (/^http:\/\/localhost(?::\d+)?$/i.test(normalized)) return true;
  if (/^http:\/\/127\.0\.0\.1(?::\d+)?$/i.test(normalized)) return true;

  return false;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      callback(
        isAllowedOrigin(origin) ? null : new Error("Origin not allowed"),
        isAllowedOrigin(origin)
      );
    },
    methods: ["GET", "PATCH", "PUT", "OPTIONS"]
  },
  serveClient: true
});

app.disable("x-powered-by");

app.use((req, res, next) => {
  const origin = req.get("Origin");

  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, PUT, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  if (req.method === "OPTIONS") {
    if (origin && !isAllowedOrigin(origin)) {
      return res.status(403).json({ error: "Origin not allowed." });
    }
    return res.sendStatus(204);
  }

  if (origin && !isAllowedOrigin(origin) && req.path.startsWith("/api/")) {
    return res.status(403).json({ error: "Origin not allowed." });
  }

  return next();
});

app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "docs")));

function makeEmptySlots() {
  return Array.from({ length: SLOT_COUNT }, () => ({
    name: "",
    notes: ""
  }));
}

async function ensureSchedule() {
  let schedule = await Schedule.findOne({ key: SCHEDULE_KEY });

  if (schedule) return schedule;

  try {
    schedule = await Schedule.create({
      key: SCHEDULE_KEY,
      slots: makeEmptySlots()
    });
    return schedule;
  } catch (error) {
    if (error?.code === 11000) {
      return Schedule.findOne({ key: SCHEDULE_KEY });
    }
    throw error;
  }
}

function serializeSchedule(schedule) {
  return {
    id: String(schedule._id),
    updatedAt: schedule.updatedAt,
    slots: schedule.slots.map((slot, index) => ({
      id: String(slot._id),
      time: TIME_LABELS[index],
      position: index,
      name: slot.name || "",
      notes: slot.notes || ""
    }))
  };
}

function emitSchedule(schedule) {
  const payload = serializeSchedule(schedule);
  io.emit("schedule:update", payload);
  return payload;
}

function emitPresence() {
  io.emit("presence:update", {
    viewers: io.engine.clientsCount
  });
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    database: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    realtime: "available"
  });
});

app.get("/api/schedule", async (req, res, next) => {
  try {
    const schedule = await ensureSchedule();
    res.json(serializeSchedule(schedule));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/schedule/slots/:slotId", async (req, res, next) => {
  try {
    const { slotId } = req.params;
    const body = req.body && typeof req.body === "object" ? req.body : {};

    if (!mongoose.isObjectIdOrHexString(slotId)) {
      return res.status(400).json({ error: "Invalid slot ID." });
    }

    const updates = {};
    const setOperations = {};

    if (Object.hasOwn(body, "name")) {
      if (typeof body.name !== "string") {
        return res.status(400).json({ error: "Name must be text." });
      }
      updates.name = body.name.trim();
      if (updates.name.length > 150) {
        return res.status(400).json({ error: "Name must be 150 characters or fewer." });
      }
      setOperations["slots.$.name"] = updates.name;
    }

    if (Object.hasOwn(body, "notes")) {
      if (typeof body.notes !== "string") {
        return res.status(400).json({ error: "Notes must be text." });
      }
      updates.notes = body.notes.trim();
      if (updates.notes.length > 2000) {
        return res.status(400).json({ error: "Notes must be 2,000 characters or fewer." });
      }
      setOperations["slots.$.notes"] = updates.notes;
    }

    if (Object.keys(setOperations).length === 0) {
      return res.status(400).json({ error: "No supported slot fields were provided." });
    }

    await ensureSchedule();

    const schedule = await Schedule.findOneAndUpdate(
      {
        key: SCHEDULE_KEY,
        "slots._id": slotId
      },
      {
        $set: setOperations
      },
      {
        new: true,
        runValidators: true
      }
    );

    if (!schedule) {
      return res.status(404).json({ error: "Schedule slot not found." });
    }

    res.json(emitSchedule(schedule));
  } catch (error) {
    next(error);
  }
});

app.put("/api/schedule/reorder", async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const { slotIds } = body;

    if (!Array.isArray(slotIds) || slotIds.length !== SLOT_COUNT) {
      return res.status(400).json({
        error: `slotIds must contain exactly ${SLOT_COUNT} items.`
      });
    }

    const normalizedIds = slotIds.map(String);
    if (new Set(normalizedIds).size !== SLOT_COUNT) {
      return res.status(400).json({ error: "slotIds must be unique." });
    }

    const schedule = await ensureSchedule();
    const currentSlots = new Map(
      schedule.slots.map((slot) => [String(slot._id), slot.toObject()])
    );

    if (normalizedIds.some((id) => !currentSlots.has(id))) {
      return res.status(400).json({ error: "The submitted order contains an unknown slot." });
    }

    schedule.slots = normalizedIds.map((id) => currentSlots.get(id));
    await schedule.save();

    res.json(emitSchedule(schedule));
  } catch (error) {
    next(error);
  }
});

app.use((req, res, next) => {
  if (req.method !== "GET") return next();
  return res.sendFile(path.join(__dirname, "docs", "index.html"));
});

app.use((error, req, res, next) => {
  console.error(error);

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).json({
    error: "The schedule could not be updated."
  });
});

io.on("connection", async (socket) => {
  try {
    const schedule = await ensureSchedule();
    socket.emit("schedule:update", serializeSchedule(schedule));
    emitPresence();
  } catch (error) {
    console.error("Socket initialization failed:", error);
  }

  socket.on("disconnect", emitPresence);
});

async function start() {
  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI or MONGO_URL is required.");
  }

  await mongoose.connect(MONGODB_URI);
  await ensureSchedule();

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Schedule server listening on port ${PORT}`);
  });
}

start().catch((error) => {
  console.error("Server failed to start:", error);
  process.exit(1);
});
