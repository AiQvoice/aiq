import "dotenv/config";
import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import twilio from "twilio";

const {
  OPENAI_API_KEY,
  DOMAIN, // ex: aiqvoice.onrender.com  (utan https)
  PORT = 10000,
} = process.env;

if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY in env");
if (!DOMAIN) throw new Error("Missing DOMAIN in env, e.g. aiqvoice.onrender.com");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

/**
 * 1) Twilio webhook för inkommande samtal
 *    Twilio hämtar TwiML härifrån.
 */
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  // Starta Media Stream till vår WS-endpoint
  const start = twiml.start();
  start.stream({
    url: `wss://${DOMAIN}/media`,
    track: "inbound_track", // vi vill ha caller->AI
  });

  // Kort intro (Twilio TTS)
  twiml.say(
    { voice: "alice", language: "sv-SE" },
    "Hej! Mitt namn är AiQ. Hur kan jag hjälpa dig?"
  );

  // Lämna samtalet öppet medan streamen kör.
  twiml.pause({ length: 60 });

  res.type("text/xml").send(twiml.toString());
});

app.get("/", (req, res) => res.send("AiQvoice is running ✅"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media" });

/**
 * 2) När Twilio kopplar upp Media Stream (WS)
 */
wss.on("connection", (twilioWS) => {
  console.log("Twilio WS connected");

  // 3) Koppla upp till OpenAI Realtime (WS)
  const openaiWS = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-5-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  let streamSid = null;
  let lastUserAudioTs = Date.now();
  let silenceTimer = null;

  function resetSilenceTimer() {
    if (silenceTimer) clearInterval(silenceTimer);
    silenceTimer = setInterval(() => {
      const now = Date.now();
      if (now - lastUserAudioTs > 5000 && openaiWS.readyState === 1) {
        // "Hallå?" om tyst i 5 sek
        openaiWS.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "Hallå, är du kvar? Vad vill du ha hjälp med?",
                },
              ],
            },
          })
        );
        openaiWS.send(JSON.stringify({ type: "response.create" }));
        lastUserAudioTs = now; // så vi inte loopar varje sekund
      }
    }, 1000);
  }

  openaiWS.on("open", () => {
    console.log("OpenAI WS open");

    // RÄTT schema: session.update med modalities
    openaiWS.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          // twilio skickar μ-law 8kHz
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: "alloy", // mjukare röst (byt senare om du vill)
          instructions:
            "Du är AiQ, en varm, snabb och levande svensk AI-assistent för företags telefonsamtal. " +
            "Svara kort, tydligt och naturligt. Avbryt inte användaren, men var snabb. " +
            "Om användaren är tyst, följ upp vänligt. Ställ frågor för att förstå vad samtalet gäller.",
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
          },
        },
      })
    );

    resetSilenceTimer();
  });

  openaiWS.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    // När OpenAI ger oss ljud -> skicka till Twilio
    if (msg.type === "response.audio.delta" && msg.delta) {
      const payload = msg.delta; // base64 redan
      if (streamSid) {
        twilioWS.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload },
          })
        );
      }
    }

    // Logga errors tydligt
    if (msg.type === "error") {
      console.error("OPENAI ERROR:", msg);
    }
  });

  openaiWS.on("close", () => {
    console.log("OpenAI WS closed");
    if (silenceTimer) clearInterval(silenceTimer);
    try { twilioWS.close(); } catch {}
  });

  openaiWS.on("error", (err) => {
    console.error("OpenAI WS error", err);
  });

  // 4) Ta emot ljud från Twilio -> skicka till OpenAI
  twilioWS.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      console.log("Stream started:", streamSid);
      return;
    }

    if (msg.event === "media") {
      lastUserAudioTs = Date.now();
      const audio = msg.media.payload; // base64 g711_ulaw

      if (openaiWS.readyState === 1) {
        openaiWS.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio,
          })
        );
      }
      return;
    }

    if (msg.event === "stop") {
      console.log("Stream stopped");
      if (openaiWS.readyState === 1) openaiWS.close();
    }
  });

  twilioWS.on("close", () => {
    console.log("Twilio WS closed");
    if (openaiWS.readyState === 1) openaiWS.close();
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
