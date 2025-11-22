import "dotenv/config";
import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ---------------------------------------------------------
// 1) TWILIO WEBHOOK – INTRO + 5s TYSTNAD + "JA HALLÅ?" + STREAM
// ---------------------------------------------------------
app.post("/voice", (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host;

  const twiml = `
  <?xml version="1.0" encoding="UTF-8"?>
  <Response>
    <Say voice="alice" language="sv-SE">
      Hej! Mitt namn är AiQ. Hur kan jag hjälpa dig?
    </Say>

    <Pause length="5"/>

    <Say voice="alice" language="sv-SE">
      Ja hallå?
    </Say>

    <Connect>
      <Stream url="wss://${host}/media-stream" />
    </Connect>
  </Response>`;

  res.type("text/xml").send(twiml);
});

app.get("/", (req, res) => res.send("aiqvoice is running"));

// ---------------------------------------------------------
// 2) WEBSOCKET: TWILIO <-> OPENAI REALTIME
// ---------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  if (request.url.startsWith("/media-stream")) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (twilioWs) => {
  console.log("🔗 Twilio WS connected");

  let streamSid = null;

  // ---------------------------------------------------------
  //  OPENAI REALTIME WS
  // ---------------------------------------------------------
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
  //  SEND NEW SESSION.UPDATE (KORREKT FORMAT!)
  // ---------------------------------------------------------
  const sendSessionUpdate = () => {
    const update = {
      type: "session.update",
      session: {
        modalities: ["audio"],           // <-- RÄTT, inte output_modalities!
        instructions:
          "Du är AiQ, en varm och levande svensk AI-assistent. Svara naturligt, kort och vänligt.",
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            turn_detection: { type: "server_vad" }
          },
          output: {
            format: { type: "audio/pcmu" },
            voice: "alloy"
          }
        }
      }
    };

    console.log("⤴️ Sending session.update");
    openAiWs.send(JSON.stringify(update));
  };

  openAiWs.on("open", () => {
    console.log("🟢 OpenAI WS open");
    setTimeout(sendSessionUpdate, 250);
  });

  // ---------------------------------------------------------
  //  OPENAI → TWILIO (SKICKA TILLBAKA AI-LJUD)
  // ------------------------------
