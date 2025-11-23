 (cd "$(git rev-parse --show-toplevel)" && git apply --3way <<'EOF' 
diff --git a/server.js b/server.js
index 2ce6e95c9462aa877bb584205a52418309fd389d..c6154b85eca4fe6f9891b6cd66883eee0e443bd7 100644
--- a/server.js
+++ b/server.js
@@ -1,36 +1,40 @@
 require("dotenv").config();
 const express = require("express");
 const http = require("http");
 const WebSocket = require("ws");
 
 const app = express();
 app.use(express.urlencoded({ extended: false }));
 
 const PORT = process.env.PORT || 10000;
 const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
 
+if (!OPENAI_API_KEY) {
+  throw new Error("Missing OPENAI_API_KEY environment variable");
+}
+
 // ----------------------
 // TWILIO VOICE WEBHOOK
 // ----------------------
 app.post("/voice", (req, res) => {
   const host = req.headers["x-forwarded-host"] || req.headers.host;
 
   const twiml =
     '<?xml version="1.0" encoding="UTF-8"?>' +
     "<Response>" +
       '<Say voice="alice" language="sv-SE">' +
         "Hej. Mitt namn är AiQ. Hur kan jag hjälpa dig i dag?" +
       "</Say>" +
 
       '<Pause length="5"/>' +
 
       '<Say voice="alice" language="sv-SE">' +
         "Hallå. Hör du mig?" +
       "</Say>" +
 
       "<Connect>" +
         '<Stream url="wss://' + host + '/media-stream" />' +
       "</Connect>" +
     "</Response>";
 
   res.type("text/xml").send(twiml);
@@ -57,90 +61,96 @@ server.on("upgrade", (req, socket, head) => {
 
 // ----------------------
 // TWILIO <-> OPENAI
 // ----------------------
 wss.on("connection", (twilioWs) => {
   console.log("Twilio WS connected");
 
   let streamSid = null;
 
   const openAiWs = new WebSocket(
     "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
     {
       headers: {
         Authorization: "Bearer " + OPENAI_API_KEY,
         "OpenAI-Beta": "realtime=v1",
       },
     }
   );
 
   function sendSessionUpdate() {
     const update = {
       type: "session.update",
       session: {
         modalities: ["audio"],
         instructions:
-          "Du ar AiQ, en varm, mjuk och lugn svensk AI-assistent. " +
-          "Prata som en vanlig mannisklig van: lugnt tempo, varm ton, " +
-          "enkla meningar, och naturliga pauser. " +
-          "Svara kort men levande. Om personen ar tyst, fraga mjukt om den ar kvar.",
+          "Du är AiQ, en varm, mjuk och lugn svensk AI-assistent. " +
+          "Prata som en vanlig mänsklig vän: lugnt tempo, varm ton, " +
+          "enkla meningar och naturliga pauser. " +
+          "Svara kort men levande. Om personen är tyst, fråga mjukt om den är kvar.",
         audio: {
           input: {
             format: { type: "audio/pcmu" },
             turn_detection: { type: "server_vad" },
           },
           output: {
             format: { type: "audio/pcmu" },
             voice: "verse",
           },
         },
       },
     };
 
     console.log("Sending session.update");
     openAiWs.send(JSON.stringify(update));
   }
 
   // OPENAI CONNECT
   openAiWs.on("open", () => {
     console.log("OpenAI WS open");
     setTimeout(sendSessionUpdate, 300);
   });
 
   openAiWs.on("message", (raw) => {
     let msg;
     try {
       msg = JSON.parse(raw.toString());
     } catch (e) {
       return;
     }
 
     if (msg.type === "error") {
       console.log("OPENAI ERROR:", msg);
       return;
     }
 
+    if (msg.type === "input_audio_buffer.speech_stopped") {
+      openAiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
+      openAiWs.send(JSON.stringify({ type: "response.create" }));
+      return;
+    }
+
     // SPEECH START -> STOP AI TALKING DIRECTLY
     if (msg.type === "input_audio_buffer.speech_started") {
       if (streamSid) {
         twilioWs.send(JSON.stringify({ event: "clear", streamSid: streamSid }));
         openAiWs.send(JSON.stringify({ type: "response.cancel" }));
       }
     }
 
     // SEND AI AUDIO BACK TO TWILIO
     if (msg.type === "response.output_audio.delta" && msg.delta && streamSid) {
       twilioWs.send(
         JSON.stringify({
           event: "media",
           streamSid: streamSid,
           media: { payload: msg.delta },
         })
       );
     }
   });
 
   openAiWs.on("close", () => console.log("OpenAI WS closed"));
   openAiWs.on("error", (err) => console.log("OpenAI WS error:", err));
 
   // TWILIO -> OPENAI AUDIO
   twilioWs.on("message", (raw) => {
 
EOF
)
