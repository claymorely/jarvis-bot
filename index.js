import { Client, GatewayIntentBits } from "discord.js";
import Groq from "groq-sdk";

const TRIGGER = "jarvis";
const SYSTEM_PROMPT =
  "You are Jarvis, a helpful Discord bot. Be concise and friendly. Keep replies under 1500 characters.";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// simple per-channel memory (last 8 messages)
const memory = new Map();

client.once("clientReady", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const mentioned =
    message.content.toLowerCase().includes(TRIGGER) ||
    message.mentions.has(client.user);

  if (!mentioned) return;

  const history = memory.get(message.channel.id) || [];

  try {
    await message.channel.sendTyping();

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...history,
        { role: "user", content: `${message.author.username}: ${message.content}` },
      ],
    });

    const reply =
      completion.choices[0]?.message?.content?.slice(0, 1900) ||
      "I couldn't think of a reply.";

    const updated = [
      ...history,
      { role: "user", content: `${message.author.username}: ${message.content}` },
      { role: "assistant", content: reply },
    ].slice(-8);

    memory.set(message.channel.id, updated);

    await message.reply(reply);
  } catch (err) {
    console.error(err);
    await message.reply("Something went wrong reaching my brain.");
  }
});

client.login(process.env.DISCORD_TOKEN);
