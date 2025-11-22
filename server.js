import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
const server = http.createServer(app);

const OPENAI_REALTIME_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";

//
// 1) INKOMMANDE SAMTAL
//
app.post("/voice", (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();

  vr.say(
    { voice: "alice", language: "sv-SE" },
    "Hej! Mitt namn är Aique. Hur kan jag hjälpa dig?"
  );

  const connect = vr.connect();
  connect.stream({
    url: "wss://aiqvoice.onrender.com/stream",
    name: "aiqvoice-realtime"
  });

  // ✅ Viktigt: håll samtalet öppet
  vr.pause({ length: 600 });

  res.type("text/xml").send(vr.toString());
});

app.get("/", (req, res) => res.send("AIQVoice realtime är igång"));

//
// 2) WEBSOCKET-SERVER (Twilio <-> OpenAI)
//
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url && req.url.startsWith("/stream")) {
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req)
    );
  } else {
    socket.destroy();
  }
});

wss.on("connection", (twilioWs) => {
  let streamSid = null;

  let openaiReady = false;
  const pendingAudio = []; // ✅ buffer tills OpenAI är redo

  const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  openaiWs.on("open", () => {
    console.log("✅ OpenAI WS open");
    openaiReady = true;

    openaiWs.send(JSON.stringify({
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
          "Du heter Aique och är en svensk AI-telefonassistent. Svara supersnabbt, kort och naturligt på svenska. Hjälp direkt. Om oklart, ställ EN kort följdfråga."
      }
    }));

    // ✅ skicka allt audio som kom innan OpenAI var redo
    while (pendingAudio.length) {
      openaiWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: pendingAudio.shift()
      }));
    }
  });

  // OpenAI -> Twilio (AI-ljud ut)
  openaiWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    // När din tal-turn är klar, trigga svar
    if (
      msg.type === "input_audio_buffer.speech_stopped" ||
      msg.type === "input_audio_buffer.committed"
    ) {
      openaiWs.send(JSON.stringify({ type: "response.create" }));
      return;
    }

    if (msg.type === "response.output_audio.delta" && msg.delta) {
      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: msg.delta }
      }));
    }
  });

  openaiWs.on("error", (e) =>
    console.error("OpenAI WS error:", e)
  );
  openaiWs.on("close", () => {
    console.log("OpenAI WS closed");
    openaiReady = false;
  });

  // Twilio -> OpenAI (din röst in)
  twilioWs.on("message", (raw) => {
    const data = JSON.parse(raw.toString());

    if (data.event === "start") {
      streamSid = data.start.streamSid;
      console.log("✅ Twilio stream start:", streamSid);
      return;
    }

    if (data.event === "media" && data.media?.payload) {
      if (!openaiReady) {
        pendingAudio.push(data.media.payload); // ✅ buffra
      } else {
        openaiWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: data.media.payload
        }));
      }
      return;
    }

    if (data.event === "stop") {
      try { openaiWs.close(); } catch {}
    }
  });

  twilioWs.on("close", () => {
    try { openaiWs.close(); } catch {}
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () =>
  console.log("🚀 Server kör på port", port)
);
