import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const server = http.createServer(app);

// Använd Twilio-bloggens modellnamn (den är gjord för realtime-telefoni)
// Om du saknar access kommer du se error i logs. :contentReference[oaicite:1]{index=1}
const OPENAI_REALTIME_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-realtime";

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

  // Connect/Stream blockar vidare TwiML, men pause är OK som “hold”
  vr.pause({ length: 600 });

  res.type("text/xml").send(vr.toString());
});

app.get("/", (req, res) => res.send("AIQVoice realtime är igång"));

//
// 2) WEBSOCKET FÖR MEDIA STREAMS
//
const wss = new WebSocketServer({ noServer: true });

// ✅ VIKTIG FIX: acceptera /stream även med querystring
server.on("upgrade", (req, socket, head) => {
  if (req.url && req.url.startsWith("/stream")) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (twilioWs) => {
  let streamSid = null;

  const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  const LOG_EVENTS = [
    "session.created",
    "session.updated",
    "input_audio_buffer.speech_started",
    "input_audio_buffer.speech_stopped",
    "response.created",
    "response.output_audio.delta",
    "response.done",
    "error"
  ];

  const sendSessionUpdate = () => {
    const sessionUpdate = {
      type: "session.update",
      session: {
        type: "realtime",
        model: "gpt-realtime",
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcmu" },           // Twilio μ-law
            turn_detection: { type: "server_vad" }   // auto turn detect
          },
          output: {
            format: { type: "audio/pcmu" },
            voice: "alloy"
          }
        },
        instructions:
          "Du är Aique, en svensk AI-telefonassistent för företag med telefonköer. Var extremt responsiv, kort, trygg och professionell. Hjälp direkt. Om oklart, fråga EN kort följdfråga. Prata svenska."
      }
    };

    console.log("Sending session.update");
    openaiWs.send(JSON.stringify(sessionUpdate));
  };

  openaiWs.on("open", () => {
    console.log("✅ OpenAI realtime connected");
    setTimeout(sendSessionUpdate, 250);
  });

  // OpenAI -> Twilio (AI-ljud ut)
  openaiWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    if (LOG_EVENTS.includes(msg.type)) {
      console.log("OpenAI event:", msg.type);
    }

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

  openaiWs.on("error", (e) => console.error("OpenAI WS error:", e));
  openaiWs.on("close", () => console.log("OpenAI WS closed"));

  // Twilio -> OpenAI (din röst in)
  twilioWs.on("message", (raw) => {
    const data = JSON.parse(raw.toString());

    if (data.event === "start") {
      streamSid = data.start.streamSid;
      console.log("✅ Twilio stream started:", streamSid);
      return;
    }

    if (data.event === "media" && data.media?.payload) {
      // forwarda din röst till OpenAI
      openaiWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: data.media.payload
      }));
      return;
    }

    if (data.event === "stop") {
      console.log("Twilio stream stopped");
      try { openaiWs.close(); } catch {}
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio WS closed");
    try { openaiWs.close(); } catch {}
  });

  twilioWs.on("error", (e) => console.error("Twilio WS error:", e));
});

const port = process.env.PORT || 3000;
server.listen(port, () => console.log("Realtime server kör på port", port));
