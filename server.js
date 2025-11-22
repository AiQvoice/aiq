import express from "express";
import { WebSocketServer } from "ws";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// Twilio kommer hit först och kräver WebSocket URL i svaret
app.post("/voice", (req, res) => {
  const response = `
    <Response>
      <Connect>
        <Stream url="wss://${req.headers.host}/media" />
      </Connect>
    </Response>
  `;

  res.type("text/xml");
  res.send(response);
});

// WebSocket-server för Twilio Media Stream
const wss = new WebSocketServer({ noServer: true });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// När Twilio ansluter med WebSocket
wss.on("connection", async (ws, req) => {
  console.log("🔗 Twilio WebSocket ansluten!");

  // Öppna anslutning till OpenAI Realtime API
  const openaiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17", {
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  openaiWs.on("open", () => {
    console.log("🤖 OpenAI WebSocket ansluten!");

    // Skicka initial prompt
    openaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        instructions: "Du heter Aique. Du är en vänlig svensk assistent. Svara direkt och naturligt.",
        modalities: ["audio"],
        voice: "alloy",
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        turn_detection: { type: "server_vad" }
      }
    }));
  });

  // När OpenAI skickar tillbaka svar → skicka till Twilio
  openaiWs.on("message", (data) => {
    const msg = JSON.parse(data.toString());

    if (msg.type === "response.output_audio.delta") {
      ws.send(JSON.stringify({
        event: "media",
        media: { payload: msg.delta }
      }));
    }
  });

  // När Twilio skickar audio → skicka till OpenAI
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());

    if (msg.event === "media") {
      openaiWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: msg.media.payload
      }));
    }

    if (msg.event === "stop") {
      openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    }
  });

  ws.on("close", () => {
    console.log("❌ Twilio WebSocket stängd");
    openaiWs.close();
  });
});

// Hantera WebSocket upgrade
const server = app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Server körs");
});

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});
