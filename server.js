import express from "express";
import bodyParser from "body-parser";
import OpenAI from "openai";
import twilio from "twilio";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- HANTERA INKOMMANDE SAMTAL ---
async function handleVoice(req, res) {
  const twiml = new twilio.twiml.VoiceResponse();

  // Svenskt välkomstmeddelande
  twiml.say(
    { voice: "alice", language: "sv-SE" },
    "Välkommen till AIQ Voice. Berätta kort vad ditt ärende gäller, så hjälper jag dig."
  );

  // Lyssna på tal
  twiml.gather({
    input: "speech",
    action: "/gather",
    method: "POST",
    timeout: 5,
    speechTimeout: "auto",
    language: "sv-SE", // <-- viktig för svenskt tal
  });

  res.type("text/xml");
  res.send(twiml.toString());
}

app.get("/voice", handleVoice);
app.post("/voice", handleVoice);

// --- HANTERA SVAR FRÅN ANVÄNDAREN ---
app.post("/gather", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const userText = req.body.SpeechResult || "";

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Du är en svensk AI-telefonassistent för ett företag med mycket telefonköer. Svara kort, vänligt och professionellt. Ställ följdfrågor vid behov.",
        },
        { role: "user", content: userText },
      ],
      max_tokens: 120,
      temperature: 0.4,
    });

    const aiText =
      completion.choices?.[0]?.message?.content?.trim() ||
      "Jag uppfattade inte det. Kan du säga det igen?";

    // Svara med svensk röst
    twiml.say({ voice: "alice", language: "sv-SE" }, aiText);

    // Lyssna igen — samtalsloop
    twiml.gather({
      input: "speech",
      action: "/gather",
      method: "POST",
      timeout: 5,
      speechTimeout: "auto",
      language: "sv-SE",
    });
  } catch (err) {
    console.error(err);
    twiml.say(
      { voice: "alice", language: "sv-SE" },
      "Ett fel inträffade. Försök igen om en liten stund."
    );
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

// Health check
app.get("/", (req, res) => res.send("AIQVoice är igång"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server kör på port", port));
