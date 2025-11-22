import 'dotenv/config';
import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 5050;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// --- Health check ---
app.get('/', (req, res) => {
  res.send('aiqvoice is running');
});

// --- Twilio hits this when a call comes in ---
app.post('/voice', (req, res) => {
  // Render ligger bakom proxy, så bygg URL säkert:
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const wsUrl = `${proto === 'https' ? 'wss' : 'ws'}://${host}/media`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="sv-SE">
    Hej! Mitt namn är AiQ. Hur kan jag hjälpa dig?
  </Say>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

  res.type('text/xml').send(twiml);
});

// --- WebSocket server for Twilio Media Streams ---
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const wss = new WebSocketServer({ server, path: '/media' });

wss.on('connection', (twilioWs) => {
  console.log('Twilio stream connected');

  let streamSid = null;

  // OpenAI Realtime WS
  const openaiWs = new WebSocket(
  'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',

    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    }
  );

  let openaiReady = false;
  const audioQueue = [];

  function sendToOpenAI(msgObj) {
    const msg = JSON.stringify(msgObj);
    if (openaiReady && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(msg);
    } else {
      // köa tills WS är öppen
      audioQueue.push(msg);
    }
  }

  openaiWs.on('open', () => {
    openaiReady = true;
    console.log('OpenAI WS open');

    // Session config (VIKTIGT: g711_ulaw matchar Twilio)
    openaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: "alloy",
        turn_detection: { type: "server_vad" },
        instructions: `
Du är AiQ, en snabb och hjälpsam svensk röstassistent.
Svara naturligt och direkt på svenska.
Håll en varm, professionell ton.
Om användaren pausar, vänta kort och fortsätt dialogen.
`
      }
    }));

    // töm kö
    while (audioQueue.length) {
      openaiWs.send(audioQueue.shift());
    }
  });

  openaiWs.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return;
    }

    // Debug (kan kommenteras bort sen)
    if (msg.type && msg.type !== 'response.audio.delta') {
      console.log('OpenAI event:', msg.type);
    }

    // När OpenAI skickar ljud tillbaka → vidare till Twilio
    if (msg.type === 'response.audio.delta' && msg.delta) {
      if (!streamSid) return;
      const twilioPayload = {
        event: "media",
        streamSid,
        media: { payload: msg.delta }
      };
      twilioWs.send(JSON.stringify(twilioPayload));
    }

    // Om användaren börjar prata → avbryt AI så den inte pratar över
    if (msg.type === 'input_audio_buffer.speech_started') {
      if (!streamSid) return;
      twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
    }

    // När OpenAI skapat ett nytt svar, be den spela upp
    if (msg.type === 'response.created') {
      // inget behövs här, audio.delta kommer automatiskt
    }
  });

  openaiWs.on('close', () => {
    console.log('OpenAI WS closed');
  });

  openaiWs.on('error', (err) => {
    console.error('OpenAI WS error:', err.message);
  });

  // Twilio → OpenAI
  twilioWs.on('message', (message) => {
    let msg;
    try {
      msg = JSON.parse(message.toString());
    } catch (e) {
      return;
    }

    if (msg.event === 'start') {
      streamSid = msg.start.streamSid;
      console.log('Stream started:', streamSid);
      return;
    }

    if (msg.event === 'media') {
      // Twilio skickar base64 g711_ulaw i media.payload
      sendToOpenAI({
        type: "input_audio_buffer.append",
        audio: msg.media.payload
      });
      return;
    }

    if (msg.event === 'stop') {
      console.log('Stream stopped');
      openaiWs.close();
      return;
    }
  });

  twilioWs.on('close', () => {
    console.log('Twilio WS closed');
    openaiWs.close();
  });
});
