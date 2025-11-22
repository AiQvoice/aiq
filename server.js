import "dotenv/config";
import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ---------------------------------------------------------
// 1) TWILIO WEBHOOK – INTRO + 5s TYST + "JA HALLÅ?" + STREAM
// ---------------------------------------------------------
app.post("/voice", (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host;

  const twiml = `
  <?xml version="1.0" encoding="UTF-8"?>
  <Response>
    <Say voice="alice" language="sv-SE">
      Hej… mitt namn är AiQ. Hur kan jag hjälpa dig i dag?
    </Say>

    <Pause length="5"/>

    <Say voice="alice" language="sv-SE">
      Hallå… hör du mig?
    </Say>

    <Connect>
      <Stream url="wss://${host}/media-stream" />
    </Connect>
  </Response>`;

  res.type("text/xml").send(twiml);
});

app.get("/", (req, res) => res.send("aiqvoice is running"));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/media-stream")) {
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

// ---------------------------------------------------------
//  TWILIO <-> OPENAI REALTIME
// ---------------------------------------------------------
wss.on("connection", (twilioWs) => {
  console.log("🔗 Twilio WS connected");

  let streamSid = null;

  const openAiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  // ---------------------------------------------------------
  // SESSION.UPDATE (extra mjuk röst + mjuk persona)
  // ---------------------------------------------------------
  const sendSessionUpdate = () => {
    const update = {
      type: "session.update",
      session: {
        modalities: ["audio"],
        instructions:
          "Du är AiQ, en varm, mjuk och lugn svensk AI-assistent. " +
          "Prata som en vänlig människa: långsammare tempo, mjuk ton, " +
          "varma vokaler, subtilt leende i rösten, och korta naturliga pauser. " +
          "Var empatisk, lyssnande och trygg. Svara kort men varmt.",
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            turn_detection: { type: "server_vad" }
          },
          output: {
            format: { type: "audio/pcmu" },
            voice: "verse"   // ⭐ MJUKASTE RÖSTEN
          }
        }
      }
    };

    console.log("⤴️ Sending session.update (soft voice)");
    openAiWs.send(JSON.stringify(update));
  };

  openAiWs.on("open", () => {
    console.log("🟢 OpenAI WS open");
    setTimeout(sendSessionUpdate, 300);
  });

  // ---------------------------------------------------------
  // OPENAI → TWILIO (AI-LJUD TILLBAKA)
  // ---------------------------------------------------------
  openAiWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "error") {
      console.log("❌ OPENAI ERROR:", msg);
      return;
    }

    if (msg.type === "response.output_audio.delta" && msg.delta && streamSid) {
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: msg.delta }
        })
      );
    }

    // Om du börjar prata → stoppa AI-ljud direkt
    if (msg.type === "inp
