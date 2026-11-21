const Eris = require("eris");

// Replace TOKEN with your bot account's token
const bot = new Eris("Bot TOKEN", {
  intents: ["guilds", "guildMessages"],
  // Controls the Gateway Identify browser/device identifier.
  // Supported: "Discord VR", "Discord iOS", "Discord Android",
  // "Discord Web", "Discord Embedded", "Discord Client"
  platform: "Discord VR",
});

bot.on("ready", () => {
  console.log("Ready!");
});

bot.on("error", (err) => {
  console.error(err);
});

bot.connect();
