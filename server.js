import "dotenv/config";
import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// 1) Twilio webhook
app.post("/voice", (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host;

  // ✅ Din nya logik:
  // - Presenterar sig
  // - Väntar 5 sek
  // - Säger "Ja hallå?"
  // - Startar realtime-stream
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
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

const server = http.createServer(app);

// 2) WebSocket route för Twilio Media Streams
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url && req.url.startsWith("/media-stream")) {
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (twilioWs) => {
  console.log("✅ Twilio WS connected");
  let streamSid = null;

  const openAiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-realtime",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  const sendSessionUpdate = () => {
    const sessionUpdate = {
      type: "session.update",
      session: {
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            turn_detection: { type: "server_vad" }
          },
          output: {
            format: { type: "audio/pcmu" },
            voice: "alloy"
          }
        },
        instructions:
          "Du är AiQ, en svensk AI-telefonassistent.\n" +
          "Låt varm, levande, snabb och professionell.\n" +
          "Svara kort och naturligt på svenska.\n" +
          "Om något är oklart, ställ EN kort följdfråga."
      }
    };

    console.log("Sending session.update");
    openAiWs.send(JSON.stringify(sessionUpdate));
  };

  openAiWs.on("open", () => {
    console.log("✅ OpenAI WS open");
    setTimeout(sendSessionUpdate, 250);
  });

  // OpenAI -> Twilio (AI-audio tillbaka)
  openAiWs.on("message", (data) => {
    let resp;
    try {
      resp = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (resp.type === "error") {
      console.log("❌ OPENAI ERROR:", resp);
      return;
    }

    // ✅ Rätt event för audio tillbaka
    if (resp.type === "response.output_audio.delta" && resp.delta) {
      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: resp.delta }
      }));
    }

    // Om du börjar prata medan AI pratar → stoppa AI-ljudet
    if (resp.type === "input_audio_buffer.speech_started") {
      if (streamSid) {
        twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
        openAiWs.send(JSON.stringify({ type: "response.cancel" }));
      }
    }
  });

  // Twilio -> OpenAI (din röst in)
  twilioWs.on("message", (message) => {
    let data;
    try {
      data = JSON.parse(message.toString());
    } catch {
      return;
    }

    if (data.event === "start") {
      streamSid = data.start.streamSid;
      console.log("Incoming stream started:", streamSid);
      return;
    }

    if (data.event === "media" && data.media?.payload) {
      if (openAiWs.readyState === WebSocket.OPEN) {
        openAiWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: data.media.payload
        }));
      }
      return;
    }

    if (data.event === "stop") {
      console.log("Stream stopped");
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio WS closed");
    if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
  });

  openAiWs.on("close", () => console.log("OpenAI WS closed"));
  openAiWs.on("error", (e) => console.error("OpenAI WS error:", e));
});

server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
