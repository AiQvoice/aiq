async function handleVoice(req, res) {
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
}

app.get("/voice", handleVoice);
app.post("/voice", handleVoice);
