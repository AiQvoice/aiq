import express from "express";
import bodyParser from "body-parser";
import OpenAI from "openai";
import twilio from "twilio";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Viktigt: absolut base-url för action-länkar
const BASE_URL = "https://aiqvoice.onrender.com";

// --- HANTERA INKOMMANDE SAMTAL ---
async function handleVoice(req, res) {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say(
    { voice: "alice", language: "sv-SE" },
    "Välkommen till AIQ Voice. Efter pipet kan du berätta kort vad ditt ärende gäller."
  );

  // liten paus för att inte klippa första ordet
  twiml.pause({ length: 1 });

  const gather = twiml.gather({
    input: "speech",
    action: `${BASE_URL}/gather`,   // ABSOLUT URL
    method: "POST",
    timeout: 8,                    // längre tid att börja prata
    speechTimeout: "auto",
    language: "sv-SE",
    actionOnEmptyResult: true,     // kör /gather även om Twilio hör tomt
  });

  // om Gather av nån anledning inte triggar, fallback:
  twiml.say(
    { voice: "alice", language: "sv-SE" },
    "Jag hörde inget. Kan du försöka igen?"
  );

  res.type("text/xml");
  res.send(twiml.toString());
}

app.get("/voice", handleVoice);
app.post("/voice", handleVoice);

// --- HANTERA SVAR FRÅN ANVÄNDAREN ---
app.post("/gather", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  // Twilio kan ibland ge tom SpeechResult
  const userText =
    (req.body.SpeechResult ||
      req.body.UnstableSpeechResult ||
      "").trim();

  // Om Twilio inte hörde något -> be om nytt försök
  if (!userText) {
    twiml.say(
      { voice: "alice", language: "sv-SE" },
      "Jag hörde dig inte riktigt. Kan du säga det en gång till, lite tydligare?"
    );

    twiml.gather({
      input: "speech",
      action: `${BASE_URL}/gather`,
      method: "POST",
      timeout: 8,
      speechTimeout: "auto",
      language: "sv-SE",
      actionOnEmptyResult: true,
    });

    res.type("text/xml");
    return res.send(twiml.toString());
  }

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Du är en svensk AI-telefonassistent för ett företag med långa telefonköer. Svara kort, vänligt och professionellt. Ställ en enkel följdfråga om det behövs.",
        },
        { role: "user", content: userText },
      ],
      max_tokens: 140,
      temperature: 0.4,
    });

    const aiText =
      completion.choices?.[0]?.message?.content?.trim() ||
      "Jag är inte helt säker på att jag förstår. Kan du förtydliga?";

    twiml.say({ voice: "alice", language: "sv-SE" }, aiText);

    // Lyssna vidare i samtalet
    twiml.gather({
      input: "speech",
      action: `${BASE_URL}/gather`,
      method: "POST",
      timeout: 8,
      speechTimeout: "auto",
      language: "sv-SE",
      actionOnEmptyResult: true,
    });
  } catch (err) {
    console.error(err);
    twiml.say(
      { voice: "alice", language: "sv-SE" },
      "Ett fel inträffade i systemet. Försök igen om en liten stund."
    );
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

// Health check
app.get("/", (req, res) => res.send("AIQVoice är igång"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server kör på port", port));
