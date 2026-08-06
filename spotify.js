import { ActivityType, EmbedBuilder } from "discord.js";

const CACHE_TIME = 5 * 60 * 1000;
const spotifyMessages = new Map();

export function registerSpotifyTracker(client, config) {
  client.on("presenceUpdate", async (oldPresence, newPresence) => {
    try {
      if (!newPresence?.member || newPresence.member.user.bot) return;

      const spotify = newPresence.activities.find(
        (activity) => activity.type === ActivityType.Listening && activity.name === "Spotify"
      );

      if (!spotify) return;

      const current = spotifyMessages.get(newPresence.userId);
      if (current?.trackId === spotify.syncId) return;

      const channelId = config.musicChannelId;
      if (!channelId) return;

      const channel = await client.channels.fetch(channelId);

      const cover = spotify.assets?.largeImage
        ? `https://i.scdn.co/image/${spotify.assets.largeImage.replace("spotify:", "")}`
        : null;

      const embed = new EmbedBuilder()
        .setColor("#1DB954")
        .setAuthor({
          name: `${newPresence.member.displayName} is listening to Spotify`,
          iconURL: newPresence.member.displayAvatarURL(),
        })
        .setTitle(spotify.details)
        .setURL(`https://open.spotify.com/track/${spotify.syncId}`)
        .setDescription(`🎤 **${spotify.state}**`)
        .addFields({ name: "💿 Album", value: spotify.assets?.largeText ?? "Unknown" })
        .setTimestamp();

      if (cover) embed.setThumbnail(cover);

      const now = Date.now();
      const withinCacheWindow = current?.messageId && now - current.lastPublishedAt < CACHE_TIME;

      try {
        if (withinCacheWindow) {
          const msg = await channel.messages.fetch(current.messageId);
          await msg.edit({ embeds: [embed] });
          spotifyMessages.set(newPresence.userId, {
            trackId: spotify.syncId,
            messageId: msg.id,
            lastPublishedAt: current.lastPublishedAt,
          });
        } else {
          const msg = await channel.send({ embeds: [embed] });
          spotifyMessages.set(newPresence.userId, {
            trackId: spotify.syncId,
            messageId: msg.id,
            lastPublishedAt: now,
          });
        }
      } catch (e) {
        console.error("Spotify message edit failed, sending a new one:", e.message);
        const msg = await channel.send({ embeds: [embed] });
        spotifyMessages.set(newPresence.userId, {
          trackId: spotify.syncId,
          messageId: msg.id,
          lastPublishedAt: now,
        });
      }
    } catch (err) {
      console.error("presenceUpdate handler error:", err);
    }
  });
}
