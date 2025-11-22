import 'dotenv/config';
import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import twilio from "twilio";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ====== 1) Twilio webhook för inkommande samtal ======
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say(
    { voice: "alice", language: "sv-SE" },
    "Hej! Mitt namn är AiQ. Hur kan jag hjälpa dig?"
  );

  // Starta Media Stream till vår WS
  twiml.connect().stream({
    url: `wss://${req.headers.host}/media`
  });

  res.type("text/xml");
  res.send(twiml.toString());
});

// healthcheck
app.get("/", (req, res) => res.send("aiqvoice is running"));

// ====== 2) Server + WS ======
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media" });

wss.on("connection", (twilioWs) => {
  console.log("Twilio WS connected");

  let streamSid = null;

  // Öppna WS mot OpenAI Realtime
  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-realtime",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  openaiWs.on("open", () => {
    console.log("OpenAI WS open");

    // Startsession
    const sessionUpdate = {
      type: "session.update",
      session: {
        // Viktigt: matcha Twilio (g711_ulaw)
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",

        // Server-VAD triggar speech_started/stopped automatiskt
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 600
        },

        // Svensk transkribering för bättre förståelse
        input_audio_transcription: {
          model: "gpt-4o-mini-transcribe",
          language: "sv"
        },

        // Röst + instruktioner
        voice: "marin",
        instructions:
          "Du är AiQ (uttalas Aique). " +
          "Svara snabbt och naturligt på svenska. " +
          "Ställ följdfrågor om något är oklart. " +
          "Avsluta inte samtalet själv."
      }
    };

    openaiWs.send(JSON.stringify(sessionUpdate));
  });

  // Ta emot ljud från Twilio -> skicka till OpenAI
  twilioWs.on("message", (msg) => {
    const data = JSON.parse(msg);

    if (data.event === "start") {
      streamSid = data.start.streamSid;
      console.log("Stream started:", streamSid);
      return;
    }

    if (data.event === "media") {
      // data.media.payload är base64 g711_ulaw
      const audioAppend = {
        type: "input_audio_buffer.append",
        audio: data.media.payload
      };
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify(audioAppend));
      }
      return;
    }

    if (data.event === "stop") {
      console.log("Stream stopped");
      openaiWs.close();
      twilioWs.close();
      return;
    }
  });

  // OpenAI events -> tillbaka till Twilio
  openaiWs.on("message", (raw) => {
    let event;
    try {
      event = JSON.parse(raw);
    } catch (e) {
      console.log("Bad JSON from OpenAI", raw.toString());
      return;
    }

    // DEBUG: logga riktiga error-event
    if (event.type === "error") {
      console.error("OpenAI ERROR:", event);
      return;
    }

    // När användaren slutat prata -> be modellen svara
    if (event.type === "input_audio_buffer.speech_stopped") {
      console.log("speech_stopped -> response.create");

      const create = {
        type: "response.create",
        response: {
          modalities: ["audio"],
          instructions:
            "Svara kort och tydligt på svenska, som en människa i realtid."
        }
      };
      openaiWs.send(JSON.stringify(create));
      return;
    }

    // Strömma tillbaka AI-ljud
    if (event.type === "response.audio.delta" && event.delta) {
      const twilioMsg = {
        event: "media",
        streamSid,
        media: { payload: event.delta }
      };
      if (twilioWs.readyState === WebSocket.OPEN) {
        twilioWs.send(JSON.stringify(twilioMsg));
      }
      return;
    }
  });

  openaiWs.on("close", () => {
    console.log("OpenAI WS closed");
  });

  openaiWs.on("error", (err) => {
    console.error("OpenAI WS socket error:", err);
  });

  twilioWs.on("close", () => {
    console.log("Twilio WS closed");
    openaiWs.close();
  });

  twilioWs.on("error", (err) => {
    console.error("Twilio WS error:", err);
  });
});

server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
