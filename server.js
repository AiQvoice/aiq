import express from "express";
import bodyParser from "body-parser";
import OpenAI from "openai";
import twilio from "twilio";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post("/voice", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say(
    { voice: "alice", language: "en-US" },
    "Welcome to A I Q Voice. Please tell me what your call is about."
  );

  twiml.gather({
    input: "speech",
    action: "/gather",
    method: "POST",
    timeout: 5,
    speechTimeout: "auto",
    language: "en-US",
  });

  res.type("text/xml");
  res.send(twiml.toString());
});

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
            "You are an AI phone assistant for a company with long queues. Keep answers short and helpful.",
        },
        { role: "user", content: userText },
      ],
      max_tokens: 100,
      temperature: 0.4,
    });

    const aiText =
      completion.choices?.[0]?.message?.content?.trim() ||
      "I didn't catch that. Could you repeat?";

    twiml.say({ voice: "alice", language: "en-US" }, aiText);

    twiml.gather({
      input: "speech",
      action: "/gather",
      method: "POST",
      timeout: 5,
      speechTimeout: "auto",
      language: "en-US",
    });
  } catch (err) {
    console.error(err);
    twiml.say(
      { voice: "alice", language: "en-US" },
      "Something went wrong. Please try again later."
    );
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

app.get("/", (req, res) => res.send("AIQVoice is running"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running on", port));
