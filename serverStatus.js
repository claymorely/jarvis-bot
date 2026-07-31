import { status } from "minecraft-server-util";
import { EmbedBuilder } from "discord.js";

const SERVER_HOST = "fabriccraft.net";
const SERVER_PORT = 25565;
const STATUS_CHANNEL_ID = "1532839139844816976";
const UPDATE_INTERVAL_MS = 60_000; // every 60 seconds

const OPTIONS = {
  timeout: 5000,
  enableSRV: true,
};

let statusMessageId = null;

async function fetchStatus() {
  try {
    const result = await status(SERVER_HOST, SERVER_PORT, OPTIONS);
    return {
      online: true,
      players: result.players.online,
      maxPlayers: result.players.max,
      version: result.version.name,
      protocol: result.version.protocol,
      motd: result.motd?.clean || "—",
      ping: result.roundTripLatency ?? null,
      sample: result.players.sample?.map((p) => p.name) || [],
      favicon: result.favicon || null,
    };
  } catch (e) {
    return {
      online: false,
      error: e.message || "Server offline or unreachable",
    };
  }
}

function buildEmbed(data) {
  const embed = new EmbedBuilder()
    .setTitle("FabricCraft Server Status")
    .setURL("https://fabriccraft.net")
    .setTimestamp();

  if (!data.online) {
    return embed
      .setColor(0xed4245)
      .setDescription("**Offline**")
      .addFields(
        { name: "Status", value: "🔴 Offline", inline: true },
        { name: "Last checked", value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true }
      );
  }

  const playerBar = `${data.players}/${data.maxPlayers}`;
  const pingText = data.ping != null ? `${data.ping} ms` : "—";

  embed
    .setColor(0x57f287)
    .setDescription("**Online**")
    .addFields(
      { name: "Players", value: playerBar, inline: true },
      { name: "Version", value: data.version || "—", inline: true },
      { name: "Ping", value: pingText, inline: true },
      { name: "TPS", value: "N/A*", inline: true },
      { name: "Address", value: `\`${SERVER_HOST}\``, inline: true },
      { name: "Last updated", value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true }
    )
    .setFooter({ text: "*TPS requires a server-side plugin and is not available via status protocol" });

  if (data.sample.length > 0) {
    const names = data.sample.slice(0, 12).join(", ");
    embed.addFields({
      name: `Online players (${Math.min(data.sample.length, 12)}${data.sample.length > 12 ? "+" : ""})`,
      value: names || "—",
    });
  }

  if (data.motd && data.motd !== "—") {
    embed.addFields({ name: "MOTD", value: data.motd.slice(0, 200) });
  }

  return embed;
}

export function startServerStatus(client) {
  const tick = async () => {
    try {
      const channel = await client.channels.fetch(STATUS_CHANNEL_ID).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        console.error("[serverStatus] Channel not found or not text-based:", STATUS_CHANNEL_ID);
        return;
      }

      const data = await fetchStatus();
      const embed = buildEmbed(data);

      if (statusMessageId) {
        try {
          const msg = await channel.messages.fetch(statusMessageId);
          await msg.edit({ embeds: [embed] });
          return;
        } catch {
          statusMessageId = null;
        }
      }

      const msg = await channel.send({ embeds: [embed] });
      statusMessageId = msg.id;
    } catch (err) {
      console.error("[serverStatus] update failed:", err.message);
    }
  };

  setTimeout(tick, 3000);
  setInterval(tick, UPDATE_INTERVAL_MS);

  console.log("[serverStatus] started — updating every", UPDATE_INTERVAL_MS / 1000, "s");
}
