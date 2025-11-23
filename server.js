import dotenv from "dotenv";
dotenv.config();

import Fastify from "fastify";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import WebSocket from "ws";

const {
  OPENAI_API_KEY,
  DOMAIN,
  PORT
} = process.env;

if (!OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY in env");
}
if (!DOMAIN) {
  throw new Error("Missing DOMAIN in env, e.g. aiqvoice.onrender.com");
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// --- Persona / system message (SVENSKA) ---
const SYSTEM_MESSAGE = `
Du är AiQ (uttalas "Aique"). Du är en varm, professionell svensk AI-telefonist.
Regler:
- Presentera dig direkt när samtalet startar: "Hej! Mitt namn är AiQ. Hur kan jag hjälpa dig?"
- Kör en naturlig dialog på svenska, korta meningar.
- Vänta inte på pip. Lyssna direkt när användaren pratar.
- Om du inte hör användaren i cirka 5 sekunder efter att du pratat klart, säg: "Hallå, är du kvar?"
- Om användaren pratar samtidigt som du pratar: sluta prata och lyssna.
`;

// Du kan testa andra röster senare.
// "alloy" funkar stabilt i Realtime.
const VOICE = "alloy";
const TEMPERATURE = 0.6;

// Root test
fastify.get("/", async (_, reply) => {
  reply.send({ ok: true, message: "AiQvoice server is running" });
});

// --- Twilio Voice webhook (inkommande samtal) ---
// Twilio kommer göra POST hit när någon ringer ditt Twilio-nummer.
fastify.post("/voice", async (req, reply) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${DOMAIN}/media-stream" />
  </Connect>
</Response>`;
  reply.header("Content-Type", "text/xml").send(twiml);
});

// --- Media Stream WS: proxy Twilio <-> OpenAI Realtime ---
fastify.register(async (fastifyInstance) => {
  fastifyInstance.get("/media-stream", { websocket: true }, (connection, req) => {
    console.log("Twilio stream connected");

    // 1) OpenAI Realtime WS (viktig modell/endpoint)
    const openAiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=gpt-realtime&temperature=${TEMPERATURE}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
      }
    );

    let streamSid = null;
    let openAiReady = false;

    const sendSessionUpdate = () => {
      const sessionUpdate = {
        type: "session.update",
        session: {
          type: "realtime",
          model: "gpt-realtime",
          output_modalities: ["audio"],
          audio: {
            input: {
              format: { type: "audio/pcmu" },
              turn_detection: { type: "server_vad" }
            },
            output: {
              format: { type: "audio/pcmu" },
              voice: VOICE
            }
          },
          instructions: SYSTEM_MESSAGE
        }
      };

      openAiWs.send(JSON.stringify(sessionUpdate));

      // AI ska prata först (greeting)
      const greet = {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: 'Starta samtalet nu med: "Hej! Mitt namn är AiQ. Hur kan jag hjälpa dig?"'
          }]
        }
      };
      openAiWs.send(JSON.stringify(greet));
      openAiWs.send(JSON.stringify({ type: "response.create" }));
    };

    openAiWs.on("open", () => {
      console.log("OpenAI WS open");
      openAiReady = true;
      setTimeout(sendSessionUpdate, 120);
    });

    openAiWs.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch (e) {
        console.error("Bad JSON from OpenAI:", data);
        return;
      }

      if (msg.type === "session.updated") {
        console.log("Session updated");
      }

      // Audio från OpenAI -> Twilio
      if (msg.type === "response.output_audio.delta" && msg.delta && streamSid) {
        const audioDelta = {
          event: "media",
          streamSid,
          media: { payload: Buffer.from(msg.delta, "base64").toString("base64") }
        };
        connection.send(JSON.stringify(audioDelta));
      }

      if (msg.type === "error") {
        console.error("OpenAI error:", msg);
      }
    });

    // 2) Twilio -> OpenAI
    connection.on("message", (message) => {
      let data;
      try {
        data = JSON.parse(message);
      } catch (e) {
        console.error("Bad JSON from Twilio:", message);
        return;
      }

      switch (data.event) {
        case "start":
          streamSid = data.start.streamSid;
          console.log("Stream started:", streamSid);
          break;

        case "media":
          // Skicka inkommande mic-audio till OpenAI
          if (openAiReady) {
            openAiWs.send(JSON.stringify({
              type: "input_audio_buffer.append",
              audio: data.media.payload
            }));
          }
          break;

        case "stop":
          console.log("Stream stopped");
          try { openAiWs.close(); } catch {}
          break;
      }
    });

    connection.on("close", () => {
      console.log("Twilio WS closed");
      try { openAiWs.close(); } catch {}
    });

    openAiWs.on("close", () => {
      console.log("OpenAI WS closed");
      try { connection.close(); } catch {}
    });

    openAiWs.on("error", (err) => {
      console.error("OpenAI WS err:", err);
    });
  });
});

const listenPort = PORT || 10000;
fastify.listen({ port: listenPort, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log("Server running on port", listenPort);
});
