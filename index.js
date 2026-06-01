require('dotenv').config();
const fs = require('fs');
const path = require('path');

const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  EmbedBuilder,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const PREFIX = '.';
const GUILD_ID = '1503876779369173263';
const STAFF_ROLE_ID = '1508178939489685624';
const VERIFY_CATEGORY_ID = '1510877767229767845';

const BOOSTER_ROLE_IDS = [
  '1509295991906369658',
  '1509166982656950292',
];

const BOOST_LOG_CHANNEL_ID = 'PUT_BOOST_LOG_CHANNEL_ID_HERE';
const BOOST_DATA_FILE = path.join(__dirname, 'boosts.json');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User],
});

const verificationChannels = new Map();
const pendingVerifications = new Set();

let boostData = loadBoostData();

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);

  client.user.setPresence({
    activities: [
      {
        name: 'discord.gg/fvgnation ♡',
      },
    ],
    status: 'online',
  });
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  await handleBoostSystemMessage(message);

  // DM verification flow
  if (message.channel.type === 1) {
    const dmContent = message.content.trim().toLowerCase();

    if (dmContent === `${PREFIX}verifyboost`) {
      pendingVerifications.add(message.author.id);
      await message.reply('♡ please send a screenshot showing your 2 boosts assigned to FVGNATION.');
      return;
    }

    if (pendingVerifications.has(message.author.id) && message.attachments.size > 0) {
      const attachment = message.attachments.first();

      try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const member = await guild.members.fetch(message.author.id).catch(() => null);

        if (!member) {
          await message.reply('You are not a member of the server.');
          return;
        }

        if (verificationChannels.has(message.author.id)) {
          await message.reply('You already have an open verification request.');
          return;
        }

        const channelName = `verify-${message.author.username}`
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '')
          .slice(0, 90);

        const channel = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: VERIFY_CATEGORY_ID,
          topic: message.author.id,
          permissionOverwrites: [
            {
              id: guild.roles.everyone.id,
              deny: [PermissionsBitField.Flags.ViewChannel],
            },
            {
              id: STAFF_ROLE_ID,
              allow: [
                PermissionsBitField.Flags.ViewChannel,
                PermissionsBitField.Flags.SendMessages,
                PermissionsBitField.Flags.ReadMessageHistory,
              ],
            },
            {
              id: client.user.id,
              allow: [
                PermissionsBitField.Flags.ViewChannel,
                PermissionsBitField.Flags.SendMessages,
                PermissionsBitField.Flags.ReadMessageHistory,
                PermissionsBitField.Flags.ManageChannels,
              ],
            },
          ],
        });

        verificationChannels.set(message.author.id, channel.id);
        pendingVerifications.delete(message.author.id);

        const embed = new EmbedBuilder()
          .setTitle('Server Boost Verification')
          .setDescription(`User: <@${message.author.id}> (\`${message.author.id}\`)\n\nUse \`${PREFIX}approve\` or \`${PREFIX}deny\`.`)
          .setImage(attachment.url)
          .setColor(0xff7aa8)
          .setTimestamp();

        await channel.send({
          content: `<@&${STAFF_ROLE_ID}> New boost verification request!`,
          embeds: [embed],
        });

        await message.reply('♡ your boost verification request has been submitted. staff will review it soon.');
      } catch (err) {
        console.error('Failed to create verification channel:', err);
        await message.reply('Something went wrong while creating your verification request. Please contact staff.');
      }

      return;
    }

    if (pendingVerifications.has(message.author.id)) {
      await message.reply('♡ please send a screenshot/image as proof of your 2 boosts.');
      return;
    }

    await message.reply(`♡ hi! to verify your boosts, send \`${PREFIX}verifyboost\` first.`);
    return;
  }

  if (!message.guild) return;

  const args = message.content.trim().split(/\s+/);
  const command = args[0].toLowerCase();

  if (command === `${PREFIX}help`) {
    await sendHelpEmbed(message);
    return;
  }

  if (command === `${PREFIX}ping`) {
    await message.reply('pong');
    return;
  }

  if (command === `${PREFIX}userinfo`) {
    await sendUserInfo(message);
    return;
  }

  if (command === `${PREFIX}say`) {
    await sendSayMessage(message);
    return;
  }

  if (command === `${PREFIX}embed`) {
    await sendCustomEmbed(message);
    return;
  }

  if (command === `${PREFIX}announce`) {
    await sendCustomAnnouncement(message);
    return;
  }
  if (command === `${PREFIX}boostcount`) {
    await sendBoostCount(message);
    return;
  }
  if (command === `${PREFIX}testboostdm`) {
  await sendTestBoostDM(message);
  return;
}

  if (
    message.channel.parentId === VERIFY_CATEGORY_ID &&
    message.member.roles.cache.has(STAFF_ROLE_ID)
  ) {
    if (command === `${PREFIX}approve`) {
      let userId = message.channel.topic || null;

      if (!userId) {
        for (const [uid, cid] of verificationChannels.entries()) {
          if (cid === message.channel.id) {
            userId = uid;
            break;
          }
        }
      }

      if (!userId) {
        await message.reply('Could not determine which user this verification belongs to.');
        return;
      }

      const member = await message.guild.members.fetch(userId).catch(() => null);

      if (!member) {
        await message.reply('User not found.');
        return;
      }

      for (const roleId of BOOSTER_ROLE_IDS) {
        if (!member.roles.cache.has(roleId)) {
          await member.roles.add(roleId, `Boost verification approved by ${message.author.tag}`);
        }
      }

      await message.channel.send(`✅ <@${userId}> has been approved and given the booster roles.`);
      await member.send('Your boost verification has been approved and you have been given the booster roles!').catch(() => null);
      return;
    }

    if (command === `${PREFIX}deny`) {
      let userId = message.channel.topic || null;

      if (!userId) {
        for (const [uid, cid] of verificationChannels.entries()) {
          if (cid === message.channel.id) {
            userId = uid;
            break;
          }
        }
      }

      if (!userId) {
        await message.reply('Could not determine which user this verification belongs to.');
        return;
      }

      const member = await message.guild.members.fetch(userId).catch(() => null);

      if (member) {
        await member.send('Your boost verification has been denied. Please contact staff for more information.').catch(() => null);
      }

      await message.channel.send(`❌ <@${userId}>'s boost verification has been denied.`);
      return;
    }

    if (command === `${PREFIX}close`) {
      let userId = null;

      for (const [uid, cid] of verificationChannels.entries()) {
        if (cid === message.channel.id) {
          userId = uid;
          break;
        }
      }

      if (userId) verificationChannels.delete(userId);

      await message.channel.send('Channel will be deleted in 5 seconds...');
      setTimeout(() => {
        message.channel.delete('Verification channel closed').catch(() => null);
      }, 5000);
    }
  }
});

async function sendHelpEmbed(message) {
  const embed = new EmbedBuilder()
    .setTitle('FVGNATION Bot Commands')
    .setDescription('Here are the commands I can use right now.')
    .addFields(
      { name: `${PREFIX}verifyboost`, value: 'DM only. Starts 2x boost verification.', inline: false },
      { name: `${PREFIX}approve`, value: 'Staff only. Approves a boost verification inside a verify channel.', inline: false },
      { name: `${PREFIX}deny`, value: 'Staff only. Denies a boost verification inside a verify channel.', inline: false },
      { name: `${PREFIX}close`, value: 'Staff only. Closes a verification channel.', inline: false },
      { name: `${PREFIX}embed #channel Title | Description`, value: 'Staff only. Sends a custom embed.', inline: false },
      { name: `${PREFIX}say #channel message`, value: 'Staff only. Makes the bot send a normal message.', inline: false },
      { name: `${PREFIX}userinfo @user`, value: 'Shows basic user info.', inline: false },
      { name: `${PREFIX}ping`, value: 'Checks if the bot is online.', inline: false },
      { name: `${PREFIX}boostcount @user`, value: 'Staff only. Shows the tracked boost count for a user.', inline: false },
  { name: `${PREFIX}testboostdm @user`, value: 'Staff only. Sends the boost verification DM for testing.', inline: false },
  { name: `${PREFIX}announce #channel content | description | image/gif url | button label | button url`, value: 'Staff only. Sends a custom announcement with an optional image/GIF and button.', inline: false }
    )
    .setColor(0xff7aa8)
    .setTimestamp();

  await message.channel.send({ embeds: [embed] });
}

async function sendUserInfo(message) {
  const target = message.mentions.members.first() || message.member;

  const embed = new EmbedBuilder()
    .setTitle(`${target.user.username}'s Info`)
    .setThumbnail(target.user.displayAvatarURL({ dynamic: true }))
    .addFields(
      { name: 'User', value: `${target.user}`, inline: true },
      { name: 'User ID', value: target.id, inline: true },
      { name: 'Joined Server', value: target.joinedAt ? `<t:${Math.floor(target.joinedAt.getTime() / 1000)}:R>` : 'Unknown', inline: true },
      { name: 'Account Created', value: `<t:${Math.floor(target.user.createdAt.getTime() / 1000)}:R>`, inline: true },
      { name: 'Boosting?', value: target.premiumSince ? 'Yes' : 'No', inline: true }
    )
    .setColor(0xff7aa8)
    .setTimestamp();

  await message.channel.send({ embeds: [embed] });
}

async function sendSayMessage(message) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const content = message.content.slice(`${PREFIX}say`.length).trim();

  if (!content) {
    await message.reply(`Use: \`${PREFIX}say #channel message\``);
    return;
  }

  const mentionedChannel = message.mentions.channels.first();
  let targetChannel = mentionedChannel || message.channel;
  let text = content;

  if (mentionedChannel) {
    text = content.replace(`<#${mentionedChannel.id}>`, '').trim();
  }

  if (!text) {
    await message.reply(`Use: \`${PREFIX}say #channel message\``);
    return;
  }

  await targetChannel.send(text);

  if (targetChannel.id !== message.channel.id) {
    await message.reply(`Message sent to ${targetChannel}.`);
  }
}

async function sendCustomEmbed(message) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const content = message.content.slice(`${PREFIX}embed`.length).trim();

  if (!content) {
    await message.reply(`Use: \`${PREFIX}embed #channel Title | Description\``);
    return;
  }

  const mentionedChannel = message.mentions.channels.first();
  let targetChannel = mentionedChannel || message.channel;
  let embedText = content;

  if (mentionedChannel) {
    embedText = content.replace(`<#${mentionedChannel.id}>`, '').trim();
  }

  const parts = embedText.split('|').map(part => part.trim());
  const title = parts[0];
  const description = parts.slice(1).join('|').trim();

  if (!title || !description) {
    await message.reply(`Use: \`${PREFIX}embed #channel Title | Description\``);
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(0xff7aa8)
    .setTimestamp();

  await targetChannel.send({ embeds: [embed] });

  if (targetChannel.id !== message.channel.id) {
    await message.reply(`Embed sent to ${targetChannel}.`);
  }
}

async function sendCustomAnnouncement(message) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const content = message.content.slice(`${PREFIX}announce`.length).trim();

  if (!content) {
    await message.reply(`Use: \`${PREFIX}announce #channel content | embed description | image/gif url | button label | button url\``);
    return;
  }

  const mentionedChannel = message.mentions.channels.first();
  let targetChannel = mentionedChannel || message.channel;
  let announcementText = content;

  if (mentionedChannel) {
    announcementText = content.replace(`<#${mentionedChannel.id}>`, '').trim();
  }

  const parts = announcementText.split('|').map(part => part.trim());
  const topContent = parts[0];
  const description = parts[1];
  const imageUrl = parts[2];
  const buttonLabel = parts[3];
  const buttonUrl = parts[4];

  if (!topContent || !description) {
    await message.reply(`Use: \`${PREFIX}announce #channel content | embed description | image/gif url | button label | button url\``);
    return;
  }

  const embed = new EmbedBuilder()
    .setDescription(description)
    .setColor(16572415)
    .setTimestamp();

  if (imageUrl && imageUrl.startsWith('http')) {
    embed.setImage(imageUrl);
  }

  const payload = {
    content: topContent,
    embeds: [embed],
  };

  if (buttonLabel && buttonUrl) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel(buttonLabel)
        .setStyle(ButtonStyle.Link)
        .setURL(buttonUrl)
    );

    payload.components = [row];
  }

  await targetChannel.send(payload);

  if (targetChannel.id !== message.channel.id) {
    await message.reply(`Announcement sent to ${targetChannel}.`);
  }
}

function loadBoostData() {
  try {
    if (!fs.existsSync(BOOST_DATA_FILE)) {
      fs.writeFileSync(BOOST_DATA_FILE, JSON.stringify({}, null, 2));
    }

    return JSON.parse(fs.readFileSync(BOOST_DATA_FILE, 'utf8'));
  } catch (err) {
    console.error('Failed to load boost data:', err);
    return {};
  }
}

function saveBoostData() {
  try {
    fs.writeFileSync(BOOST_DATA_FILE, JSON.stringify(boostData, null, 2));
  } catch (err) {
    console.error('Failed to save boost data:', err);
  }
}

async function handleBoostSystemMessage(message) {
  if (!message.guild) return;

  const systemTypes = [8, 9, 10, 11];

  if (!systemTypes.includes(message.type)) return;
  if (!message.author) return;

  const userId = message.author.id;
  const currentBoosts = boostData[userId]?.boosts || 0;
  const newBoosts = currentBoosts + 1;

  boostData[userId] = {
    boosts: newBoosts,
    username: message.author.tag,
    lastBoostedAt: new Date().toISOString(),
  };

  saveBoostData();

  await sendBoostLog(message, newBoosts);

  if (newBoosts >= 2) {
    await remindUserToVerify(message.author, newBoosts);
  }
}

async function sendBoostLog(message, boostCount) {
  try {
    const channel = await message.guild.channels.fetch(BOOST_LOG_CHANNEL_ID).catch(() => null);

    if (!channel) return;

    const embed = new EmbedBuilder()
      .setTitle('Boost Logged')
      .setDescription(`${message.author} boosted the server.`)
      .addFields(
        { name: 'User', value: `${message.author.tag}`, inline: true },
        { name: 'Tracked Boosts', value: `${boostCount}`, inline: true }
      )
      .setColor(0xff7aa8)
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('Failed to send boost log:', err);
  }
}

async function remindUserToVerify(user, boostCount) {
  try {
    await user.send(`Thank you for boosting FVGNATION ${boostCount} times. You may qualify for 2x booster perks. Send \`${PREFIX}verifyboost\` here to start verification.`);
  } catch (err) {
    console.error(`Could not DM ${user.tag} about boost verification.`);
  }
}

async function sendBoostCount(message) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const target = message.mentions.users.first();

  if (!target) {
    await message.reply(`Use: \`${PREFIX}boostcount @user\``);
    return;
  }

  const data = boostData[target.id];
  const count = data?.boosts || 0;

  const embed = new EmbedBuilder()
    .setTitle('Tracked Boost Count')
    .setDescription(`${target} has **${count}** tracked boost message(s).`)
    .setColor(0xff7aa8)
    .setTimestamp();

  await message.channel.send({ embeds: [embed] });
}


async function sendTestBoostDM(message) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const target = message.mentions.users.first();

  if (!target) {
    await message.reply(`Use: \`${PREFIX}testboostdm @user\``);
    return;
  }

  try {
    await target.send(
      `♡ thank you for boosting FVGNATION 2 times. You may qualify for 2x booster perks. Send \`${PREFIX}verifyboost\` here to start verification.`
    );

    await message.reply(`✅ Test boost DM sent to ${target.tag}.`);
  } catch (err) {
    await message.reply('❌ Failed to send DM. They probably have DMs disabled.');
  }
}

client.login(process.env.TOKEN);