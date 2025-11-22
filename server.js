import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const server = http.createServer(app);

// ÄNDRA INTE om du kör samma domän:
const BASE_URL = "https://aiqvoice.onrender.com";

// OpenAI Realtime WS-endpoint (officiell)
const OPENAI_REALTIME_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";

// ---- 1) Twilio webhook när samtal kommer in ----
app.post("/voice", (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();

  // Din exakta hälsning, ingen pip
  vr.say(
    { voice: "alice", language: "sv-SE" },
    "Hej! Mitt namn är AiQ, det uttalas Aique."
  );

  // Starta BIDIRECTIONAL stream så vi kan spela upp AI-ljud i samtalet
  const connect = vr.connect();
  connect.stream({
    url: `wss://aiqvoice.onrender.com/stream`,
    name: "aiqvoice-realtime"
  });

  // Håll samtalet öppet (Twilio måste ha något efter Stream)
  vr.pause({ length: 600 });

  res.type("text/xml").send(vr.toString());
});

// GET för test i browser
app.get("/voice", (req, res) => app._router.handle(req, res));

// health
app.get("/", (req, res) => res.send("AIQVoice realtime är igång"));

// ---- 2) WebSocket-server för Twilio Media Streams ----
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/stream") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (twilioWs) => {
  let streamSid = null;
  let callSid = null;
  let openaiWs = null;
  let openaiReady = false;

  // Öppna OpenAI Realtime WS
  openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  openaiWs.on("open", () => {
    // Viktigt: matcha Twilios format (g711_ulaw 8k) så vi slipper konvertera
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: "alloy",
          instructions:
            "Du är AiQ (uttalas Aique). Svensk AI-telefonassistent. Superresponsiv, kort, trygg och professionell. Hjälp direkt. Om något är oklart, fråga EN kort följdfråga. Prata svenska.",
          turn_detection: {
            type: "server_vad"
          }
        }
      })
    );

    openaiReady = true;
  });

  openaiWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    // OpenAI skickar TTS-audio i små deltas
    if (msg.type === "response.audio.delta" && msg.delta) {
      // Skicka rakt tillbaka till Twilio streamen
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: msg.delta }
        })
      );
    }

    // (valfritt) logga text för debugging
    if (msg.type === "response.text.delta") {
      // console.log("AiQ text:", msg.delta);
    }
  });

  openaiWs.on("close", () => {
    openaiReady = false;
  });

  openaiWs.on("error", (e) => {
    console.error("OpenAI WS error:", e);
  });

  // Ta emot Twilio audio
  twilioWs.on("message", (raw) => {
    const data = JSON.parse(raw.toString());

    if (data.event === "start") {
      streamSid = data.start.streamSid;
      callSid = data.start.callSid;
      return;
    }

    if (data.event === "media" && data.media?.payload) {
      if (!openaiReady) return;

      // Skicka caller-audio till OpenAI
      openaiWs.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: data.media.payload
        })
      );
    }

    if (data.event === "stop") {
      try {
        openaiWs.close();
      } catch {}
    }
  });

  twilioWs.on("close", () => {
    try {
      openaiWs.close();
    } catch {}
  });

  twilioWs.on("error", (e) => {
    console.error("Twilio WS error:", e);
  });
});

// Start server
const port = process.env.PORT || 3000;
server.listen(port, () => console.log("Realtime server kör på", port));
