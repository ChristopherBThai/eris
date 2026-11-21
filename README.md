Eris [![NPM version](https://img.shields.io/npm/v/eris.svg?style=flat-square&color=informational)](https://npmjs.com/package/eris)
====

A Node.js wrapper for interfacing with Discord.

Installing
----------

You will need NodeJS 10.4+. If you need voice support you will also need Python 2.7 and a C++ compiler. Refer to [the Getting Started section of the docs](https://abal.moe/Eris/docs) for more details.

```
npm install --no-optional eris
```

If you need voice support, remove the `--no-optional`.

Ping Pong Example
-----------------

```js
const Eris = require("eris");

// Replace TOKEN with your bot account's token
const bot = new Eris("Bot TOKEN", {
    intents: [
        "guildMessages"
    ]
});

bot.on("ready", () => { // When the bot is ready
    console.log("Ready!"); // Log "Ready!"
});

bot.on("error", (err) => {
  console.error(err); // or your preferred logger
});

bot.on("messageCreate", (msg) => { // When a message is created
    if(msg.content === "!ping") { // If the message content is "!ping"
        bot.createMessage(msg.channel.id, "Pong!");
        // Send a message in the same channel with "Pong!"
    } else if(msg.content === "!pong") { // Otherwise, if the message is "!pong"
        bot.createMessage(msg.channel.id, "Ping!");
        // Respond with "Ping!"
    }
});

bot.connect(); // Get the bot to connect to Discord
```

Gateway platform identification
--------------------------------

You can choose the client identifier sent in the Gateway Identify `browser` property with the `platform` option. Eris keeps the existing `device` property unchanged. This is separate from the bot's online presence status, which is still controlled by `bot.editStatus()`.

Supported values are `"Discord VR"`, `"Discord iOS"`, `"Discord Android"`, `"Discord Web"`, `"Discord Embedded"`, and `"Discord Client"` (exact capitalization required).

```js
const Eris = require("eris");

// VR
const vrBot = new Eris("Bot TOKEN", { platform: "Discord VR" });

// iOS
const iosBot = new Eris("Bot TOKEN", { platform: "Discord iOS" });

// Web
const webBot = new Eris("Bot TOKEN", { platform: "Discord Web" });

// Embedded
const embeddedBot = new Eris("Bot TOKEN", { platform: "Discord Embedded" });

vrBot.connect();
```

If `platform` is omitted, Eris retains its default `"Eris"` identifier. Invalid values throw a `TypeError`. This changes only the Gateway Identify properties; it does not change presence, activity, or guarantee how Discord displays the client.

More examples can be found in [the examples folder](https://github.com/abalabahaha/eris/tree/master/examples).

Useful Links
------------

- [The website](https://abal.moe/Eris/) has more details and documentation.
- [The official Eris server](https://abal.moe/Eris/invite) is the best place to get support.
- [The GitHub repo](https://github.com/abalabahaha/eris) is where development primarily happens.
- [The NPM package webpage](https://npmjs.com/package/eris) is, well, the webpage for the NPM package.

License
-------

Refer to the [LICENSE](LICENSE) file.
