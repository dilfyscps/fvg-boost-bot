const fs = require('fs');
const path = require('path');
const config = require('./config');
const storage = require('./storage');
const logger = require('./logger');
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

const {
  PREFIX,
  GUILD_ID,
  STAFF_ROLE_ID,
  VERIFY_CATEGORY_ID,
  MOD_APP_CATEGORY_ID,
  MOD_APP_LOG_CHANNEL_ID,
  BOOSTER_ROLE_IDS,
  BOOST_LOG_CHANNEL_ID,
  BOOST_DATA_FILE,
} = config;

const MOD_APPLICATION_QUESTIONS = [
  'What is your Discord username and age?',
  'What timezone are you in?',
  'Why do you want to be a moderator for FVGNATION?',
  'Do you have any past moderation experience? If yes, explain.',
  'How active can you be each day?',
  'How would you handle someone breaking the rules?',
  'Anything else staff should know?',
];

// BOOSTER_ROLE_IDS, BOOST_LOG_CHANNEL_ID and BOOST_DATA_FILE come from config

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
const modApplications = new Map();

const modApplicationChannels = new Map();

const WARNINGS_FILE = path.join(__dirname, 'warnings.json');

let warnings = {};

try {
  if (fs.existsSync(WARNINGS_FILE)) {
    warnings = JSON.parse(fs.readFileSync(WARNINGS_FILE, 'utf8'));
  } else {
    fs.writeFileSync(WARNINGS_FILE, JSON.stringify({}, null, 2));
  }
} catch (err) {
  logger.error('Failed to load warnings', err);
}

let boostData = storage.loadBoostData(BOOST_DATA_FILE);

client.once('ready', () => {
  logger.info(`Logged in as ${client.user.tag}`);

  try {
    client.user.setPresence({
      activities: [
        {
          name: 'discord.gg/fvgnation ♡',
        },
      ],
      status: 'online',
    });
  } catch (err) {
    logger.warn('Failed to set presence', err);
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  await handleBoostSystemMessage(message);

  // DM verification + mod application flow
  if (message.channel.type === 1) {
    const dmContent = message.content.trim().toLowerCase();

    if (dmContent === `${PREFIX}modapply`) {
      if (modApplications.has(message.author.id)) {
        await message.reply('♡ you already have a mod application in progress. please answer the current question.');
        return;
      }

      modApplications.set(message.author.id, {
        step: 0,
        answers: [],
      });

      await message.reply(`♡ mod application started!\n\n**Question 1/${MOD_APPLICATION_QUESTIONS.length}:** ${MOD_APPLICATION_QUESTIONS[0]}`);
      return;
    }

    if (modApplications.has(message.author.id)) {
      await handleModApplicationAnswer(message);
      return;
    }

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
        logger.error('Failed to create verification channel:', err);
        await message.reply('Something went wrong while creating your verification request. Please contact staff.');
      }

      return;
    }

    if (pendingVerifications.has(message.author.id)) {
      await message.reply('♡ please send a screenshot/image as proof of your 2 boosts.');
      return;
    }

    await message.reply(`♡ hi! send \`${PREFIX}verifyboost\` to verify boosts or \`${PREFIX}modapply\` to apply for mod.`);
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

  if (command === `${PREFIX}addboost`) {
    const hasStaffRole = message.member.roles.cache.has(STAFF_ROLE_ID);
    const hasManage = message.member.permissions?.has(PermissionsBitField.Flags.ManageGuild) || message.member.permissions?.has(PermissionsBitField.Flags.Administrator);

    if (!hasStaffRole && !hasManage) {
      await message.reply('You do not have permission to use this command.');
      return;
    }

    const target = message.mentions.users.first();
    const amount = parseInt(args[2], 10);

    if (!target || !Number.isInteger(amount) || amount < 0) {
      await message.reply(`Use: \`${PREFIX}addboost @user amount\``);
      return;
    }

    boostData[target.id] = {
      ...(boostData[target.id] || {}),
      boosts: amount,
      verifiedBoosts: amount,
      verified: amount > 0,
      username: target.tag,
      verifiedAt: new Date().toISOString(),
      verifiedBy: message.author.id,
      lostBoostAlerted: false,
    };

    storage.saveBoostData(BOOST_DATA_FILE, boostData);

    logger.info(`addboost: ${message.author.tag} set ${target.tag} -> ${amount}`);
    await message.reply(`✅ Set ${target.tag}'s verified boost count to **${amount}**.`);
    return;
  }

  if (command === `${PREFIX}boosterlist`) {
    await sendBoosterList(message);
    return;
  }

  if (command === `${PREFIX}purge`) {
    await purgeMessages(message, args);
    return;
  }
  if (command === `${PREFIX}warn`) {
    await warnUser(message);
    return;
  }

  if (command === `${PREFIX}warnings`) {
    await showWarnings(message);
    return;
  }

  if (command === `${PREFIX}clearwarns`) {
    await clearWarnings(message);
    return;
  }

  if (command === `${PREFIX}modpending`) {
  await message.reply(`📋 Open mod applications: ${modApplicationChannels.size}`);
  return;
}

if (command === `${PREFIX}modstats`) {
  const embed = new EmbedBuilder()
    .setTitle('Mod Application Stats')
    .addFields(
      { name: 'Open Applications', value: `${modApplicationChannels.size}`, inline: true },
      { name: 'Applications In Progress', value: `${modApplications.size}`, inline: true }
    )
    .setColor(0xff7aa8);

  await message.channel.send({ embeds: [embed] });
  return;
}

if (command === `${PREFIX}closemod`) {
  const userId = message.channel.topic || null;

  if (userId) {
    modApplicationChannels.delete(userId);
  }

  await message.channel.send('🔒 Mod application channel will be deleted in 5 seconds...');

  setTimeout(() => {
    message.channel.delete('Mod application closed').catch(() => null);
  }, 5000);

  return;
}

if (command === `${PREFIX}note`) {
  const note = message.content.slice(`${PREFIX}note`.length).trim();

  if (!note) {
    await message.reply(`Use: \`${PREFIX}note your note here\``);
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('Staff Note')
    .setDescription(note)
    .setFooter({ text: `Added by ${message.author.tag}` })
    .setColor(0xff7aa8)
    .setTimestamp();

  await message.channel.send({ embeds: [embed] });

  return;
}

  if (
    message.channel.parentId === MOD_APP_CATEGORY_ID &&
    message.member.roles.cache.has(STAFF_ROLE_ID)
  ) {
    if (command === `${PREFIX}acceptmod`) {
      const userId = message.channel.topic || null;

      if (!userId) {
        await message.reply('Could not determine which user this application belongs to.');
        return;
      }

      const member = await message.guild.members.fetch(userId).catch(() => null);

      if (member) {
        await member.send('♡ your FVGNATION mod application has been accepted! staff will contact you soon.').catch(() => null);
      }

      modApplicationChannels.delete(userId);
      await message.channel.send(`✅ <@${userId}>'s mod application has been accepted.`);
      return;
    }

    if (command === `${PREFIX}denymod`) {
      const userId = message.channel.topic || null;

      if (!userId) {
        await message.reply('Could not determine which user this application belongs to.');
        return;
      }

      const member = await message.guild.members.fetch(userId).catch(() => null);

      if (member) {
        await member.send('♡ your FVGNATION mod application has been denied. thank you for applying.').catch(() => null);
      }

      modApplicationChannels.delete(userId);
      await message.channel.send(`❌ <@${userId}>'s mod application has been denied.`);
      return;
    }
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

      // Update tracked boost count on approval
      try {
        const userIdStr = member.id;
        const current = boostData[userIdStr]?.boosts || 0;
        boostData[userIdStr] = {
          boosts: Math.max(current, 2),
          username: member.user.tag,
          lastBoostedAt: new Date().toISOString(),
        };

        storage.saveBoostData(BOOST_DATA_FILE, boostData);
      } catch (err) {
        logger.error('Failed to update boostData on approval', err);
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
  const isStaff = message.member && message.member.roles && message.member.roles.cache.has(STAFF_ROLE_ID);

  const pages = [
    {
      id: 'general',
      title: 'General',
      body: `\`${PREFIX}help\` — Show this help message\n\`${PREFIX}ping\` — Check if the bot is online\n\`${PREFIX}userinfo @user\` — Show basic user info`,
    },
    {
      id: 'boosting',
      title: 'Boosting',
      body: `\`${PREFIX}verifyboost\` (DM) — Start 2x boost verification flow\n\`${PREFIX}boostcount @user\` — Show tracked boosts for a user\n\`${PREFIX}addboost @user amount\` — (Staff) Set verified boost count\n\`${PREFIX}boosterlist\` — (Staff) View all verified boosters\n\`${PREFIX}testboostdm @user\` — (Staff) Send test verification DM`,
    },
    {
      id: 'moderation',
      title: 'Moderator Applications',
      body: `\`${PREFIX}modapply\` (DM) — Start a moderator application\n\`${PREFIX}modpending\` — (Staff) View open mod applications\n\`${PREFIX}modstats\` — (Staff) Mod application stats\n\`${PREFIX}acceptmod\` / \`${PREFIX}denymod\` — (Staff) Accept or deny an application\n\`${PREFIX}closemod\` — (Staff) Close a mod application channel`,
    },
    {
      id: 'staff',
      title: 'Staff Tools',
      body: `\`${PREFIX}approve\` / \`${PREFIX}deny\` — (Staff) Approve/deny a verification channel\n\`${PREFIX}purge amount\` — (Staff) Delete recent messages\n\`${PREFIX}warn @user reason\` — (Staff) Warn a user\n\`${PREFIX}warnings @user\` — View a user's warnings\n\`${PREFIX}clearwarns @user\` — (Staff) Clear a user's warnings\n\`${PREFIX}close\` — (Staff) Close a verification channel\n\`${PREFIX}note your note\` — (Staff) Add a note to the channel\n\`${PREFIX}say #channel message\` — (Staff) Make the bot send a message\n\`${PREFIX}embed #channel Title | Description\` — (Staff) Send a custom embed\n\`${PREFIX}announce #channel content | description | image/gif url | button label | button url\` — (Staff) Send an announcement with optional image/button`,
    },
  ];

  const buildEmbed = (page) => new EmbedBuilder()
    .setTitle(`FVGNATION Bot — ${page.title}`)
    .setDescription(page.body)
    .setColor(0xff7aa8)
    .setTimestamp();

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('help_general').setLabel('General').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('help_boosting').setLabel('Boosting').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('help_mod').setLabel('Mod Apps').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('help_staff').setLabel('Staff').setStyle(ButtonStyle.Danger).setDisabled(!isStaff),
    new ButtonBuilder().setCustomId('help_close').setLabel('Close').setStyle(ButtonStyle.Secondary),
  );

  const initial = pages[0];
  const helpMessage = await message.channel.send({ embeds: [buildEmbed(initial)], components: [buttons] });

  const filter = (i) => i.user.id === message.author.id;
  const collector = helpMessage.createMessageComponentCollector({ filter, time: 120000 });

  collector.on('collect', async (interaction) => {
    try {
      if (interaction.user.id !== message.author.id) {
        await interaction.reply({ content: 'You cannot control this help menu.', ephemeral: true });
        return;
      }

      if (interaction.customId === 'help_close') {
        const disabledRow = ActionRowBuilder.from(buttons);
        disabledRow.components.forEach(c => c.setDisabled(true));
        await interaction.update({ components: [disabledRow], embeds: [buildEmbed(initial)] });
        collector.stop('closed');
        return;
      }

      let pageKey = 'general';

      if (interaction.customId === 'help_general') pageKey = 'general';
      if (interaction.customId === 'help_boosting') pageKey = 'boosting';
      if (interaction.customId === 'help_mod') pageKey = 'moderation';
      if (interaction.customId === 'help_staff') pageKey = 'staff';

      const page = pages.find(p => p.id === pageKey) || pages[0];

      // If staff page requested but user is not staff, inform them
      if (page.id === 'staff' && !isStaff) {
        await interaction.reply({ content: 'Staff tools are only visible to staff members.', ephemeral: true });
        return;
      }

      await interaction.update({ embeds: [buildEmbed(page)], components: [buttons] });
    } catch (err) {
      logger.error('Help menu interaction error', err);
    }
  });

  collector.on('end', async () => {
    try {
      const disabledRow = ActionRowBuilder.from(buttons);
      disabledRow.components.forEach(c => c.setDisabled(true));
      await helpMessage.edit({ components: [disabledRow] }).catch(() => null);
    } catch (err) {
      // ignore
    }
  });
}

function saveWarnings() {
  try {
    fs.writeFileSync(WARNINGS_FILE, JSON.stringify(warnings, null, 2));
  } catch (err) {
    logger.error('Failed to save warnings', err);
  }
}

async function purgeMessages(message, args) {
  const hasStaffRole = message.member.roles.cache.has(STAFF_ROLE_ID);
  const hasManageMessages = message.member.permissions?.has(PermissionsBitField.Flags.ManageMessages) || message.member.permissions?.has(PermissionsBitField.Flags.Administrator);

  if (!hasStaffRole && !hasManageMessages) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const botMember = message.guild.members.me;
  const botCanManageMessages = botMember?.permissionsIn(message.channel).has(PermissionsBitField.Flags.ManageMessages);

  if (!botCanManageMessages) {
    await message.reply('I need the **Manage Messages** permission to purge messages here.');
    return;
  }

  const amount = parseInt(args[1], 10);

  if (!Number.isInteger(amount) || amount < 1 || amount > 99) {
    await message.reply(`Use: \`${PREFIX}purge amount\` — amount must be between **1** and **99**.`);
    return;
  }

  try {
    const deleted = await message.channel.bulkDelete(amount + 1, true);
    const deletedCount = Math.max(deleted.size - 1, 0);

    const reply = await message.channel.send(`✅ Purged **${deletedCount}** message(s).`);

    setTimeout(() => {
      reply.delete().catch(() => null);
    }, 5000);
  } catch (err) {
    logger.error('Failed to purge messages', err);
    await message.channel.send('❌ Could not purge messages. Messages older than 14 days cannot be bulk deleted.');
  }
}

async function warnUser(message) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const target = message.mentions.members.first();

  if (!target) {
    await message.reply(`Use: \`${PREFIX}warn @user reason\``);
    return;
  }

  if (target.id === message.author.id) {
    await message.reply('You cannot warn yourself.');
    return;
  }

  if (target.user.bot) {
    await message.reply('You cannot warn bots.');
    return;
  }

  const reason = message.content.split(' ').slice(2).join(' ').trim() || 'No reason provided';

  if (!warnings[target.id]) {
    warnings[target.id] = [];
  }

  warnings[target.id].push({
    moderatorId: message.author.id,
    moderatorTag: message.author.tag,
    reason,
    date: new Date().toISOString(),
  });

  saveWarnings();

  const count = warnings[target.id].length;

  const embed = new EmbedBuilder()
    .setTitle('User Warned')
    .setDescription(`${target} has been warned.`)
    .addFields(
      { name: 'Reason', value: reason, inline: false },
      { name: 'Total Warnings', value: `${count}`, inline: true },
      { name: 'Moderator', value: `${message.author}`, inline: true }
    )
    .setColor(0xffaa55)
    .setTimestamp();

  await message.channel.send({ embeds: [embed] });

  await target.send(`♡ you were warned in FVGNATION.\nReason: ${reason}`).catch(() => null);
}

async function showWarnings(message) {
  const target = message.mentions.users.first();

  if (!target) {
    await message.reply(`Use: \`${PREFIX}warnings @user\``);
    return;
  }

  const userWarnings = warnings[target.id] || [];

  if (userWarnings.length === 0) {
    await message.reply(`${target.tag} has no warnings.`);
    return;
  }

  const lines = userWarnings.slice(0, 10).map((warning, index) => {
    const date = warning.date
      ? `<t:${Math.floor(new Date(warning.date).getTime() / 1000)}:R>`
      : 'Unknown date';

    return `**${index + 1}.** ${warning.reason}\nModerator: <@${warning.moderatorId}> • ${date}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`Warnings for ${target.tag}`)
    .setDescription(lines.join('\n\n'))
    .setFooter({ text: userWarnings.length > 10 ? `Showing 10 of ${userWarnings.length}` : `${userWarnings.length} warning(s)` })
    .setColor(0xffaa55)
    .setTimestamp();

  await message.channel.send({ embeds: [embed] });
}

async function clearWarnings(message) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const target = message.mentions.users.first();

  if (!target) {
    await message.reply(`Use: \`${PREFIX}clearwarns @user\``);
    return;
  }

  const oldCount = warnings[target.id]?.length || 0;
  delete warnings[target.id];
  saveWarnings();

  await message.channel.send(`✅ Cleared **${oldCount}** warning(s) for ${target.tag}.`);
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

async function handleModApplicationAnswer(message) {
  const application = modApplications.get(message.author.id);

  if (!application) return;

  const answer = message.content.trim();

  if (!answer) {
    await message.reply('♡ please type an answer for this question.');
    return;
  }

  application.answers.push(answer);
  application.step += 1;

  if (application.step < MOD_APPLICATION_QUESTIONS.length) {
    modApplications.set(message.author.id, application);
    await message.reply(`♡ saved!\n\n**Question ${application.step + 1}/${MOD_APPLICATION_QUESTIONS.length}:** ${MOD_APPLICATION_QUESTIONS[application.step]}`);
    return;
  }

  modApplications.delete(message.author.id);

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(message.author.id).catch(() => null);

    if (!member) {
      await message.reply('You are not a member of the server.');
      return;
    }

    if (modApplicationChannels.has(message.author.id)) {
      await message.reply('♡ you already have an open mod application. staff will review it soon.');
      return;
    }

    const channelName = `mod-app-${message.author.username}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 90);

    const channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: MOD_APP_CATEGORY_ID,
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

    modApplicationChannels.set(message.author.id, channel.id);

    const formattedAnswers = MOD_APPLICATION_QUESTIONS.map((question, index) => {
      return `**${index + 1}. ${question}**\n${application.answers[index] || 'No answer'}`;
    }).join('\n\n');

    const embed = new EmbedBuilder()
      .setTitle('New Mod Application')
      .setDescription(`Applicant: <@${message.author.id}> (\`${message.author.id}\`)\n\n${formattedAnswers}\n\nUse \`${PREFIX}acceptmod\` or \`${PREFIX}denymod\`.`)
      .setColor(0xff7aa8)
      .setThumbnail(message.author.displayAvatarURL({ dynamic: true }))
      .setTimestamp();

    await channel.send({
      content: `<@&${STAFF_ROLE_ID}> New mod application!`,
      embeds: [embed],
    });

    if (MOD_APP_LOG_CHANNEL_ID) {
      const logChannel = await guild.channels.fetch(MOD_APP_LOG_CHANNEL_ID).catch(() => null);

      if (logChannel && logChannel.id !== channel.id) {
        await logChannel.send(`♡ new mod application from <@${message.author.id}>: ${channel}`);
      }
    }

    await message.reply('♡ your mod application has been submitted. staff will review it soon!');
  } catch (err) {
    logger.error('Failed to submit mod application:', err);
    await message.reply('Something went wrong while submitting your mod application. Please contact staff.');
  }
}

// boost data load/save moved to storage.js

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

  storage.saveBoostData(BOOST_DATA_FILE, boostData);

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
    logger.error('Failed to send boost log:', err);
  }
}

async function remindUserToVerify(user, boostCount) {
  try {
    await user.send(`Thank you for boosting FVGNATION ${boostCount} times. You may qualify for 2x booster perks. Send \`${PREFIX}verifyboost\` here to start verification.`);
  } catch (err) {
    logger.error(`Could not DM ${user.tag} about boost verification.`);
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

async function sendBoosterList(message) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const boosters = Object.entries(boostData)
    .filter(([, data]) => data?.verifiedBoosts > 0)
    .sort((a, b) => (b[1].verifiedBoosts || 0) - (a[1].verifiedBoosts || 0));

  if (boosters.length === 0) {
    await message.reply('♡ no verified boosters found.');
    return;
  }

  const lines = boosters.slice(0, 25).map(([userId, data], index) => {
    const verifiedAt = data.verifiedAt
      ? ` — verified <t:${Math.floor(new Date(data.verifiedAt).getTime() / 1000)}:R>`
      : '';

    return `**${index + 1}.** <@${userId}> — **${data.verifiedBoosts}** boost(s)${verifiedAt}`;
  });

  const embed = new EmbedBuilder()
    .setTitle('💎 Verified Booster List')
    .setDescription(lines.join('\n'))
    .setFooter({ text: boosters.length > 25 ? `Showing 25 of ${boosters.length}` : `${boosters.length} verified booster(s)` })
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