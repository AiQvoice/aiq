import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const server = http.createServer(app);

// OpenAI Realtime WS endpoint
const OPENAI_REALTIME_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";

//
// 1) INKOMMANDE SAMTAL -> starta realtime-stream
//
app.post("/voice", (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();

  // ⭐ DIN RENA HÄLSNING ⭐
  vr.say(
    { voice: "alice", language: "sv-SE" },
    "Hej! Mitt namn är Aique. Hur kan jag hjälpa dig?"
  );

  // <Connect><Stream> = bidirectional Media Streams
  const connect = vr.connect();
  connect.stream({
    url: "wss://aiqvoice.onrender.com/stream",
    name: "aiqvoice-realtime"
  });

  // håll samtalet öppet
  vr.pause({ length: 600 });

  res.type("text/xml").send(vr.toString());
});

// Health check
app.get("/", (req, res) => res.send("AIQVoice realtime är igång"));

//
// 2) WebSocket-server: Twilio Media Stream <-> OpenAI Realtime
//
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/stream") {
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit("connection", ws);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (twilioWs) => {
  let streamSid = null;
  let openaiReady = false;

  // Koppla upp mot OpenAI Realtime
  const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  openaiWs.on("open", () => {
    // Twilio Media Streams använder G.711 μ-law (PCMU).
    // Vi matchar input/output för lägsta latency. :contentReference[oaicite:1]{index=1}
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
          "Du är Aique, en svensk AI-telefonassistent för företag med telefonköer. Var extremt responsiv, kort, trygg och professionell. Hjälp direkt. Om något är oklart, fråga EN kort följdfråga. Prata svenska."
      }
    };

    setTimeout(() => {
      openaiWs.send(JSON.stringify(sessionUpdate));
      openaiReady = true;
    }, 250);
  });

  //
  // 3) OPENAI -> TWILIO (AI-ljud tillbaka)
  //
  openaiWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    // OpenAI skickar ljud i response.output_audio.delta via WS. :contentReference[oaicite:2]{index=2}
    if (msg.type === "response.output_audio.delta" && msg.delta) {
      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid,
        media: {
          payload: Buffer.from(msg.delta, "base64").toString("base64")
        }
      }));
    }
  });

  //
  // 4) TWILIO -> OPENAI (caller-ljud in)
  //
  twilioWs.on("message", (raw) => {
    const data = JSON.parse(raw.toString());

    if (data.event === "start") {
      streamSid = data.start.streamSid;
      return;
    }

    if (data.event === "media" && data.media?.payload && openaiReady) {
      openaiWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: data.media.payload
      }));
    }

    if (data.event === "stop") {
      try { openaiWs.close(); } catch {}
    }
  });

  twilioWs.on("close", () => {
    try { openaiWs.close(); } catch {}
  });

  openaiWs.on("close", () => { openaiReady = false; });
  openaiWs.on("error", (e) => console.error("OpenAI WS error:", e));
  twilioWs.on("error", (e) => console.error("Twilio WS error:", e));
});

//
// Starta server
//
const port = process.env.PORT || 3000;
server.listen(port, () => console.log("Realtime server kör på port", port));
