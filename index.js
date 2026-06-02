const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('./config');
const storage = require('./storage');
const logger = require('./logger');
let supabase = {
  isSupabaseConfigured: () => false,
  loadBoosterList: async () => [],
  saveBoosterList: async () => ({ count: 0 }),
  loadStickyMessages: async () => ({}),
  saveStickyMessage: async () => ({ saved: false, reason: 'Supabase module fallback is active. Check supabase.js load error in logs.' }),
  deleteStickyMessage: async () => ({ deleted: false, reason: 'Supabase module fallback is active. Check supabase.js load error in logs.' }),
  loadAutoresponders: async () => [],
  saveAutoresponders: async () => ({ saved: false, reason: 'Supabase module fallback is active. Check supabase.js load error in logs.' }),
};

try {
  supabase = require('./supabase');
} catch (err) {
  logger.error(`Supabase module could not be loaded: ${err.message}`, err);
}
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
  ActivityType,
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

const DATA_DIR = process.env.DATA_DIR || __dirname;

const WARNINGS_FILE = path.join(__dirname, 'warnings.json');
const TWITTER_FEEDS_FILE = path.join(__dirname, 'twitter-feeds.json');
const STICKY_MESSAGES_FILE = path.join(__dirname, 'sticky-messages.json');
const AUTORESPONDERS_FILE = path.join(__dirname, 'autoresponders.json');
const CHANNEL_PRESETS_FILE = path.join(DATA_DIR, 'channel-presets.json');
const LASTFM_USERS_FILE = path.join(DATA_DIR, 'lastfm-users.json');

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
let twitterFeeds = loadTwitterFeeds();
let stickyMessages = loadStickyMessages();
let autoresponders = loadAutoresponders();
let channelPresets = loadChannelPresets();
let lastfmUsers = loadLastfmUsers();

if (supabase.loadStickyMessages) {
  supabase.loadStickyMessages()
    .then(data => {
      if (data && typeof data === 'object') {
        stickyMessages = data;
        logger.info(`Loaded ${Object.keys(data).length} sticky messages from Supabase.`);
      }
    })
    .catch(err => logger.error('Failed to load sticky messages from Supabase', err));
}

if (supabase.loadAutoresponders) {
  supabase.loadAutoresponders()
    .then(data => {
      if (Array.isArray(data)) {
        autoresponders = data;
        logger.info(`Loaded ${data.length} autoresponders from Supabase.`);
      }
    })
    .catch(err => logger.error('Failed to load autoresponders from Supabase', err));
}

client.once('ready', async () => {
  logger.info(`Logged in as ${client.user.tag}`);

  try {
    const statuses = [
      {
        name: 'discord.gg/fvgnation',
        type: ActivityType.Watching,
      },
      {
        name: 'playin with cvms h0le',
        type: ActivityType.Playing,
      },
      {
        name: 'JOIN FVGNATION',
        type: ActivityType.Listening,
      },
      {
        name: 'playin with bttms h0le',
        type: ActivityType.Playing,
      },
    ];

    let statusIndex = 0;

    const updatePresence = () => {
      client.user.setPresence({
        activities: [statuses[statusIndex]],
        status: 'online',
      });

      statusIndex = (statusIndex + 1) % statuses.length;
    };

    updatePresence();
    setInterval(updatePresence, 120000);
  } catch (err) {
    logger.warn('Failed to set presence', err);
  }

  if (config.SUPABASE_AUTO_SYNC === 'true' && supabase.isSupabaseConfigured()) {
    try {
      const remoteBoosters = await supabase.loadBoosterList();
      remoteBoosters.forEach((row) => {
        if (!row || !row.user_id) return;
        boostData[row.user_id] = {
          ...(boostData[row.user_id] || {}),
          username: row.username || boostData[row.user_id]?.username,
          boosts: row.boosts ?? boostData[row.user_id]?.boosts ?? 0,
          verifiedBoosts: row.verified_boosts ?? boostData[row.user_id]?.verifiedBoosts ?? 0,
          verified: row.verified ?? boostData[row.user_id]?.verified ?? false,
          verifiedAt: row.verified_at || boostData[row.user_id]?.verifiedAt,
          verifiedBy: row.verified_by || boostData[row.user_id]?.verifiedBy,
          lastBoostedAt: row.last_boosted_at || boostData[row.user_id]?.lastBoostedAt,
          lostBoostAlerted: row.lost_boost_alerted ?? boostData[row.user_id]?.lostBoostAlerted ?? false,
        };
      });
      storage.saveBoostData(BOOST_DATA_FILE, boostData);
      logger.info(`Loaded ${remoteBoosters.length} boosters from Supabase`);
    } catch (err) {
      logger.error('Failed to sync booster list from Supabase on startup', err);
    }
  }

  if (typeof startTwitterFeedWatcher === 'function') {
    startTwitterFeedWatcher();
  } else {
    logger.warn('Twitter feed watcher is not available; skipping automatic Twitter feed checks.');
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  await handleStickyMessageActivity(message);
  await handleBoostSystemMessage(message);
  await handleAutoresponder(message);

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

  if (command === `${PREFIX}fm` || command === `${PREFIX}np`) {
    await sendLastfmNowPlaying(message, args);
    return;
  }

  if (command === `${PREFIX}f`) {
    await sendLastfmNowPlaying(message, args);
    return;
  }

  if (command === `${PREFIX}r`) {
    await sendLastfmRecent(message, args);
    return;
  }


  if (command === `${PREFIX}p`) {
    await sendLastfmProfile(message);
    return;
  }

  if (
    command === `${PREFIX}profile` ||
    command === `${PREFIX}stats` ||
    command === `${PREFIX}u`
  ) {
    await sendLastfmProfile(message);
    return;
  }

  if (command === `${PREFIX}lastfm` || command === `${PREFIX}lfm`) {
    await sendLastfmProfile(message);
    return;
  }

  if (command === `${PREFIX}ta`) {
    await sendLastfmTopArtists(message, args);
    return;
  }

  if (command === `${PREFIX}tt`) {
    await sendLastfmTopTracks(message, args);
    return;
  }


  if (command === `${PREFIX}tal`) {
    await sendLastfmTopAlbums(message, args);
    return;
  }

  if (command === `${PREFIX}tab`) {
    await sendLastfmTopAlbums(message, args);
    return;
  }

  if (command === `${PREFIX}wk`) {
    await sendLastfmWhoKnows(message, args);
    return;
  }



  if (command === `${PREFIX}setfm`) {
    await setLastfmUser(message, args);
    return;
  }

  if (command === `${PREFIX}recent`) {
    await sendLastfmRecent(message, args);
    return;
  }

  if (command === `${PREFIX}fmprofile`) {
    await sendLastfmProfile(message);
    return;
  }

  if (command === `${PREFIX}topartists`) {
    await sendLastfmTopArtists(message, args);
    return;
  }

  if (command === `${PREFIX}toptracks`) {
    await sendLastfmTopTracks(message, args);
    return;
  }

  if (command === `${PREFIX}topalbums`) {
    await sendLastfmTopAlbums(message, args);
    return;
  }

  if (command === `${PREFIX}taste` || command === `${PREFIX}t`) {
    await sendLastfmTaste(message);
    return;
  }

  if (command === `${PREFIX}whoknows`) {
    await sendLastfmWhoKnows(message, args);
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

    if (supabase.isSupabaseConfigured()) {
      try {
        await supabase.saveBoosterList(boostData);
      } catch (err) {
        logger.error('Failed to save addboost change to Supabase', err);
      }
    }

    logger.info(`addboost: ${message.author.tag} set ${target.tag} -> ${amount}`);
    await message.reply(`✅ Set ${target.tag}'s verified boost count to **${amount}**.`);
    return;
  }

  if (command === `${PREFIX}removeboost`) {
    const hasStaffRole = message.member.roles.cache.has(STAFF_ROLE_ID);
    const hasManage = message.member.permissions?.has(PermissionsBitField.Flags.ManageGuild) || message.member.permissions?.has(PermissionsBitField.Flags.Administrator);

    if (!hasStaffRole && !hasManage) {
      await message.reply('You do not have permission to use this command.');
      return;
    }

    const target = message.mentions.users.first();

    if (!target) {
      await message.reply(`Use: \`${PREFIX}removeboost @user\``);
      return;
    }

    const oldBoostData = boostData[target.id] || {};
    const oldBoostCount = oldBoostData.verifiedBoosts || oldBoostData.boosts || 0;

    boostData[target.id] = {
      ...oldBoostData,
      boosts: 0,
      verifiedBoosts: 0,
      verified: false,
      username: target.tag,
      removedAt: new Date().toISOString(),
      removedBy: message.author.id,
      oldVerifiedBoosts: oldBoostCount,
      lostBoostAlerted: true,
    };

    storage.saveBoostData(BOOST_DATA_FILE, boostData);

    if (supabase.isSupabaseConfigured()) {
      try {
        await supabase.saveBoosterList(boostData);
      } catch (err) {
        logger.error('Failed to save removeboost change to Supabase', err);
      }
    }

    await message.reply(`✅ Removed ${target.tag} from the verified booster list.`);
    return;
  }

  if (command === `${PREFIX}boosterlist`) {
    await sendBoosterList(message);
    return;
  }

  if (command === `${PREFIX}lostboosters`) {
    await sendLostBoosters(message);
    return;
  }

  if (command === `${PREFIX}syncboosters`) {
    await syncBoosters(message);
    return;
  }

  if (command === `${PREFIX}twitteradd`) {
    await addTwitterFeed(message, args);
    return;
  }

  if (command === `${PREFIX}twitterlist`) {
    await listTwitterFeeds(message);
    return;
  }

  if (command === `${PREFIX}twitterremove`) {
    await removeTwitterFeed(message, args);
    return;
  }

  if (command === `${PREFIX}twittercheck`) {
    await runTwitterFeedCheck(message);
    return;
  }

  if (command === `${PREFIX}tweetpost` || command === `${PREFIX}tp`) {
    await sendTweetPost(message, args);
    return;
  }

  if (command === `${PREFIX}channelpreset` || command === `${PREFIX}cpreset`) {
    await handleChannelPresetCommand(message, args);
    return;
  }

  if (command === `${PREFIX}stickymessage` || command === `${PREFIX}sticky` || command === `${PREFIX}sickymessage`) {
    await handleStickyMessageCommand(message, args);
    return;
  }

  if (command === `${PREFIX}autoresponder` || command === `${PREFIX}ar`) {
    await handleAutoresponderCommand(message, args);
    return;
  }

  if (command === `${PREFIX}stickymessagelist`) {
    await listStickyMessages(message);
    return;
  }

  if (command === `${PREFIX}teststicky`) {
    await testStickySupabase(message);
    return;
  }

  if (command === `${PREFIX}purge`) {
    await purgeMessages(message, args);
    return;
  }

  if (command === `${PREFIX}timeout`) {
    await timeoutUser(message, args);
    return;
  }

  if (command === `${PREFIX}untimeout`) {
    await untimeoutUser(message);
    return;
  }

  if (command === `${PREFIX}lock`) {
    await lockChannel(message);
    return;
  }

  if (command === `${PREFIX}unlock`) {
    await unlockChannel(message);
    return;
  }

  if (command === `${PREFIX}serverstats`) {
    await sendServerStats(message);
    return;
  }

  if (command === `${PREFIX}avatar`) {
    await sendAvatar(message);
    return;
  }

  if (command === `${PREFIX}kick`) {
    await kickUser(message, args);
    return;
  }

  if (command === `${PREFIX}ban`) {
    await banUser(message, args);
    return;
  }

  if (command === `${PREFIX}unban`) {
    await unbanUser(message, args);
    return;
  }

  if (command === `${PREFIX}purgeuser`) {
    await purgeUserMessages(message, args);
    return;
  }

  if (command === `${PREFIX}role`) {
    await addRoleToUser(message);
    return;
  }

  if (command === `${PREFIX}removerole`) {
    await removeRoleFromUser(message);
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
        const verifiedBoosts = Math.max(current, 2);

        boostData[userIdStr] = {
          ...(boostData[userIdStr] || {}),
          boosts: verifiedBoosts,
          verifiedBoosts,
          verified: true,
          username: member.user.tag,
          verifiedAt: new Date().toISOString(),
          verifiedBy: message.author.id,
          lastBoostedAt: new Date().toISOString(),
          lostBoostAlerted: false,
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

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
    if (!oldMember.guild || oldMember.guild.id !== GUILD_ID) return;

    const wasBoosting = Boolean(oldMember.premiumSince);
    const isBoosting = Boolean(newMember.premiumSince);

    if (wasBoosting && !isBoosting) {
      await handleBoosterRemoved(newMember);
    }
  } catch (err) {
    logger.error('Failed to handle guildMemberUpdate booster removal', err);
  }
});

async function handleBoosterRemoved(member) {
  const existing = boostData[member.id];

  if (!existing || !existing.verified) return;
  if (existing.lostBoostAlerted) return;

  const oldBoostCount = existing.verifiedBoosts || existing.boosts || 0;

  boostData[member.id] = {
    ...existing,
    boosts: 0,
    verifiedBoosts: 0,
    verified: false,
    username: member.user.tag,
    lostBoostAt: new Date().toISOString(),
    oldVerifiedBoosts: oldBoostCount,
    lostBoostAlerted: true,
  };

  storage.saveBoostData(BOOST_DATA_FILE, boostData);

  if (supabase.isSupabaseConfigured()) {
    try {
      await supabase.saveBoosterList(boostData);
    } catch (err) {
      logger.error('Failed to save lost booster update to Supabase', err);
    }
  }

  const logChannel = await member.guild.channels.fetch('1511119505684955256').catch(() => null);

  if (logChannel) {
    const embed = new EmbedBuilder()
      .setTitle('Booster Removed')
      .setDescription(`${member.user} is no longer boosting and was removed from the verified booster list.`)
      .addFields(
        { name: 'User', value: `${member.user.tag}`, inline: true },
        { name: 'User ID', value: member.id, inline: true },
        { name: 'Old Verified Boosts', value: `${existing.verifiedBoosts || existing.boosts || 0}`, inline: true }
      )
      .setColor(0xff5555)
      .setTimestamp();

    await logChannel.send({ embeds: [embed] });
  }

}

async function sendHelpEmbed(message) {
  const isStaff = message.member && message.member.roles && message.member.roles.cache.has(STAFF_ROLE_ID);

  const pages = [
    {
      id: 'general',
      title: 'General',
      body: `\`${PREFIX}help\` — Show this help message
\`${PREFIX}ping\` — Check if the bot is online
\`${PREFIX}setfm username\` — Save your Last.fm username
\`${PREFIX}fm\` — Show your current Last.fm track
\`${PREFIX}np\` — Same as fm
\`${PREFIX}recent\` / \`${PREFIX}r\` — Show recent scrobbles
\`${PREFIX}profile\` / \`${PREFIX}stats\` / \`${PREFIX}u\` — Show your Last.fm profile
\`${PREFIX}lastfm\` / \`${PREFIX}lfm\` — Show your Last.fm profile
\`${PREFIX}topartists\` / \`${PREFIX}ta\` — Show top artists
\`${PREFIX}toptracks\` / \`${PREFIX}tt\` — Show top tracks
\`${PREFIX}topalbums\` / \`${PREFIX}tab\` — Show top albums
\`${PREFIX}taste @user\` / \`${PREFIX}t @user\` — Compare music taste
\`${PREFIX}whoknows artist\` / \`${PREFIX}wk artist\` — Server artist leaderboard
Use time periods with top commands: \`${PREFIX}ta w\`, \`${PREFIX}tt m\`, \`${PREFIX}tab a\`
Periods: \`w\` weekly, \`m\` monthly, \`a\` alltime
\`${PREFIX}userinfo @user\` — Show basic user info`,
    },
    {
      id: 'boosting',
      title: 'Boosting',
      body: `\`${PREFIX}verifyboost\` (DM) — Start 2x boost verification flow\n\`${PREFIX}boostcount @user\` — Show tracked boosts for a user\n\`${PREFIX}addboost @user amount\` — (Staff) Set verified boost count\n\`${PREFIX}boosterlist\` — (Staff) View all verified boosters\n\`${PREFIX}lostboosters\` — (Staff) View users who lost verified boost status\n\`${PREFIX}removeboost @user\` — (Staff) Remove a verified booster\nAuto-detects when verified boosters stop boosting and removes them from the verified list.\n\`${PREFIX}testboostdm @user\` — (Staff) Send test verification DM`,
    },
    {
      id: 'moderation',
      title: 'Moderator Applications',
      body: `\`${PREFIX}modapply\` (DM) — Start a moderator application\n\`${PREFIX}modpending\` — (Staff) View open mod applications\n\`${PREFIX}modstats\` — (Staff) Mod application stats\n\`${PREFIX}acceptmod\` / \`${PREFIX}denymod\` — (Staff) Accept or deny an application\n\`${PREFIX}closemod\` — (Staff) Close a mod application channel`,
    },
    {
      id: 'staff',
      title: 'Staff Tools',
      body: `\`${PREFIX}approve\` / \`${PREFIX}deny\` — (Staff) Approve/deny a verification channel
\`${PREFIX}purge amount\` — (Staff) Delete recent messages
\`${PREFIX}timeout @user 1h reason\` — (Staff) Timeout a user
\`${PREFIX}untimeout @user\` — (Staff) Remove a timeout
\`${PREFIX}lock\` / \`${PREFIX}unlock\` — (Staff) Lock or unlock a channel
\`${PREFIX}serverstats\` — View server statistics
\`${PREFIX}avatar @user\` — View a user's avatar
\`${PREFIX}kick @user reason\` — (Staff) Kick a user
\`${PREFIX}ban @user reason\` — (Staff) Ban a user
\`${PREFIX}unban userID reason\` — (Staff) Unban a user by ID
\`${PREFIX}purgeuser @user amount\` — (Staff) Delete a user's recent messages
\`${PREFIX}role @user @role\` — (Staff) Give a user a role
\`${PREFIX}removerole @user @role\` — (Staff) Remove a role from a user
\`${PREFIX}warn @user reason\` — (Staff) Warn a user
\`${PREFIX}warnings @user\` — View a user's warnings
\`${PREFIX}clearwarns @user\` — (Staff) Clear a user's warnings
\`${PREFIX}close\` — (Staff) Close a verification channel
\`${PREFIX}note your note\` — (Staff) Add a note to the channel
\`${PREFIX}autoresponder add trigger | response\` — (Staff) Add an autoresponder
\`${PREFIX}autoresponder list\` — (Staff) List autoresponders
\`${PREFIX}autoresponder remove trigger\` — (Staff) Remove an autoresponder
\`${PREFIX}say #channel message\` — (Staff) Make the bot send a message
\`${PREFIX}embed #channel Title | Description\` — (Staff) Send a custom embed
\`${PREFIX}announce #channel content | description | image/gif url | button label | button url\` — (Staff) Send an announcement with optional image/button
\`${PREFIX}twitteradd username #channel rssFeedUrl\` — (Staff) Watch an X/Twitter RSS feed
\`${PREFIX}twitterlist\` — (Staff) View watched X/Twitter feeds
\`${PREFIX}twitterremove username\` — (Staff) Remove a watched X/Twitter feed
\`${PREFIX}twittercheck\` — (Staff) Manually check watched feeds now
\`${PREFIX}tweetpost #channel tweetLink\` / \`${PREFIX}tp preset tweetLink\` — (Staff) Extract and send only the tweet image/video file
\`${PREFIX}channelpreset set name #channel\` — (Staff) Save a channel preset
\`${PREFIX}channelpreset list\` — (Staff) View channel presets
\`${PREFIX}channelpreset delete name\` — (Staff) Delete a channel preset`,
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

function loadTwitterFeeds() {
  try {
    if (fs.existsSync(TWITTER_FEEDS_FILE)) {
      return JSON.parse(fs.readFileSync(TWITTER_FEEDS_FILE, 'utf8'));
    }

    fs.writeFileSync(TWITTER_FEEDS_FILE, JSON.stringify([], null, 2));
    return [];
  } catch (err) {
    logger.error('Failed to load Twitter feeds', err);
    return [];
  }
}

function saveTwitterFeeds() {
  try {
    fs.writeFileSync(TWITTER_FEEDS_FILE, JSON.stringify(twitterFeeds, null, 2));
  } catch (err) {
    logger.error('Failed to save Twitter feeds', err);
  }
}

function loadChannelPresets() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });

    if (fs.existsSync(CHANNEL_PRESETS_FILE)) {
      return JSON.parse(fs.readFileSync(CHANNEL_PRESETS_FILE, 'utf8'));
    }

    fs.writeFileSync(CHANNEL_PRESETS_FILE, JSON.stringify({}, null, 2));
    return {};
  } catch (err) {
    logger.error('Failed to load channel presets', err);
    return {};
  }
}

function saveChannelPresets() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CHANNEL_PRESETS_FILE, JSON.stringify(channelPresets, null, 2));
  } catch (err) {
    logger.error('Failed to save channel presets', err);
  }
}

async function handleChannelPresetCommand(message, args) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const subcommand = args[1]?.toLowerCase();

  if (subcommand === 'set' || subcommand === 'add') {
    const presetName = args[2]?.toLowerCase();
    const channel = message.mentions.channels.first();

    if (!presetName || !channel) {
      await message.reply(`Use: \`${PREFIX}channelpreset set name #channel\``);
      return;
    }

    channelPresets[presetName] = channel.id;
    saveChannelPresets();

    await message.reply(`✅ Saved preset **${presetName}** for ${channel}.`);
    return;
  }

  if (subcommand === 'list') {
    const entries = Object.entries(channelPresets || {});

    if (!entries.length) {
      await message.reply('No channel presets saved yet.');
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('Channel Presets')
      .setDescription(entries.map(([name, channelId]) => `**${name}** → <#${channelId}>`).join('\n'))
      .setColor(0xff7aa8)
      .setTimestamp();

    await message.channel.send({ embeds: [embed] });
    return;
  }

  if (subcommand === 'delete' || subcommand === 'remove') {
    const presetName = args[2]?.toLowerCase();

    if (!presetName) {
      await message.reply(`Use: \`${PREFIX}channelpreset delete name\``);
      return;
    }

    if (!channelPresets[presetName]) {
      await message.reply(`No preset found named **${presetName}**.`);
      return;
    }

    delete channelPresets[presetName];
    saveChannelPresets();

    await message.reply(`✅ Deleted preset **${presetName}**.`);
    return;
  }

  await message.reply(
    `Use:\n` +
    `\`${PREFIX}channelpreset set name #channel\`\n` +
    `\`${PREFIX}channelpreset list\`\n` +
    `\`${PREFIX}channelpreset delete name\``
  );
}

function loadStickyMessages() {
  try {
    if (fs.existsSync(STICKY_MESSAGES_FILE)) {
      return JSON.parse(fs.readFileSync(STICKY_MESSAGES_FILE, 'utf8'));
    }

    fs.writeFileSync(STICKY_MESSAGES_FILE, JSON.stringify({}, null, 2));
    return {};
  } catch (err) {
    logger.error('Failed to load sticky messages', err);
    return {};
  }
}

function saveStickyMessages() {
  try {
    fs.writeFileSync(STICKY_MESSAGES_FILE, JSON.stringify(stickyMessages, null, 2));
  } catch (err) {
    logger.error('Failed to save sticky messages', err);
  }
}

function loadAutoresponders() {
  try {
    if (fs.existsSync(AUTORESPONDERS_FILE)) {
      return JSON.parse(fs.readFileSync(AUTORESPONDERS_FILE, 'utf8'));
    }

    fs.writeFileSync(AUTORESPONDERS_FILE, JSON.stringify([], null, 2));
    return [];
  } catch (err) {
    logger.error('Failed to load autoresponders', err);
    return [];
  }
}

function saveAutoresponders() {
  try {
    fs.writeFileSync(AUTORESPONDERS_FILE, JSON.stringify(autoresponders, null, 2));
  } catch (err) {
    logger.error('Failed to save autoresponders', err);
  }
  if (supabase.saveAutoresponders) {
    supabase.saveAutoresponders(autoresponders)
      .catch(err => logger.error('Failed to save autoresponders to Supabase', err));
  }
}

function loadLastfmUsers() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });

    if (fs.existsSync(LASTFM_USERS_FILE)) {
      return JSON.parse(fs.readFileSync(LASTFM_USERS_FILE, 'utf8'));
    }

    fs.writeFileSync(LASTFM_USERS_FILE, JSON.stringify({}, null, 2));
    return {};
  } catch (err) {
    logger.error('Failed to load Last.fm users', err);
    return {};
  }
}

function saveLastfmUsers() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LASTFM_USERS_FILE, JSON.stringify(lastfmUsers, null, 2));
  } catch (err) {
    logger.error('Failed to save Last.fm users', err);
  }
}

async function setLastfmUser(message, args) {
  const username = args[1];

  if (!username) {
    await message.reply(`Use: \`${PREFIX}setfm your_lastfm_username\``);
    return;
  }

  lastfmUsers[message.author.id] = username;
  saveLastfmUsers();

  await message.reply(`Saved your Last.fm as **${username}** ♫`);
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

async function timeoutUser(message, args) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) return;

  const target = message.mentions.members.first();
  if (!target) {
    await message.reply(`Use: \`${PREFIX}timeout @user 1h reason\``);
    return;
  }

  const durationText = args[2];
  if (!durationText) return message.reply('Provide a duration like 10m, 1h, or 1d.');

  let duration = 0;
  if (durationText.endsWith('m')) duration = parseInt(durationText) * 60000;
  if (durationText.endsWith('h')) duration = parseInt(durationText) * 3600000;
  if (durationText.endsWith('d')) duration = parseInt(durationText) * 86400000;

  if (!duration || duration < 1000) return message.reply('Invalid duration.');

  const reason = args.slice(3).join(' ') || 'No reason provided';

  await target.timeout(duration, reason);
  await message.channel.send(`⏳ ${target} has been timed out for **${durationText}**.`);
}

async function untimeoutUser(message) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) return;

  const target = message.mentions.members.first();
  if (!target) return message.reply(`Use: \`${PREFIX}untimeout @user\``);

  await target.timeout(null);
  await message.channel.send(`✅ Removed timeout from ${target}.`);
}

async function lockChannel(message) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) return;

  await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, {
    SendMessages: false,
  });

  await message.channel.send('🔒 Channel locked.');
}

async function unlockChannel(message) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) return;

  await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, {
    SendMessages: null,
  });

  await message.channel.send('🔓 Channel unlocked.');
}

async function sendServerStats(message) {
  const guild = message.guild;

  await guild.members.fetch().catch(() => null);

  const owner = await guild.fetchOwner().catch(() => null);
  const members = guild.members.cache;
  const humans = members.filter(member => !member.user.bot).size;
  const bots = members.filter(member => member.user.bot).size;

  const textChannels = guild.channels.cache.filter(channel => channel.type === ChannelType.GuildText).size;
  const voiceChannels = guild.channels.cache.filter(channel => channel.type === ChannelType.GuildVoice).size;
  const categoryChannels = guild.channels.cache.filter(channel => channel.type === ChannelType.GuildCategory).size;
  const announcementChannels = guild.channels.cache.filter(channel => channel.type === ChannelType.GuildAnnouncement).size;
  const stageChannels = guild.channels.cache.filter(channel => channel.type === ChannelType.GuildStageVoice).size;
  const forumChannels = guild.channels.cache.filter(channel => channel.type === ChannelType.GuildForum).size;

  const roleCount = Math.max(guild.roles.cache.size - 1, 0);
  const emojiCount = guild.emojis.cache.size;
  const stickerCount = guild.stickers.cache.size;
  const boostCount = guild.premiumSubscriptionCount || 0;
  const boostTier = guild.premiumTier ? `Tier ${guild.premiumTier}` : 'No tier';
  const createdTimestamp = Math.floor(guild.createdAt.getTime() / 1000);
  const verificationLevel = guild.verificationLevel?.toString() || 'Unknown';

  const embed = new EmbedBuilder()
    .setTitle(`${guild.name} Server Statistics`)
    .setThumbnail(guild.iconURL({ size: 1024, dynamic: true }))
    .addFields(
      {
        name: 'Server Info',
        value:
          `**Owner:** ${owner ? owner.user.tag : 'Unknown'}\n` +
          `**Server ID:** \`${guild.id}\`\n` +
          `**Created:** <t:${createdTimestamp}:D> (<t:${createdTimestamp}:R>)\n` +
          `**Verification:** ${verificationLevel}`,
        inline: false,
      },
      {
        name: 'Members',
        value:
          `**Total:** ${guild.memberCount}\n` +
          `**Humans:** ${humans}\n` +
          `**Bots:** ${bots}`,
        inline: true,
      },
      {
        name: 'Boosting',
        value:
          `**Boosts:** ${boostCount}\n` +
          `**Level:** ${boostTier}`,
        inline: true,
      },
      {
        name: 'Channels',
        value:
          `**Text:** ${textChannels}\n` +
          `**Voice:** ${voiceChannels}\n` +
          `**Categories:** ${categoryChannels}\n` +
          `**Announcements:** ${announcementChannels}\n` +
          `**Stages:** ${stageChannels}\n` +
          `**Forums:** ${forumChannels}\n` +
          `**Total:** ${guild.channels.cache.size}`,
        inline: false,
      },
      {
        name: 'Server Assets',
        value:
          `**Roles:** ${roleCount}\n` +
          `**Emojis:** ${emojiCount}\n` +
          `**Stickers:** ${stickerCount}`,
        inline: true,
      }
    )
    .setColor(0xff7aa8)
    .setFooter({ text: `Requested by ${message.author.tag}` })
    .setTimestamp();

  await message.channel.send({ embeds: [embed] });
}

async function sendAvatar(message) {
  const target = message.mentions.users.first() || message.author;

  const embed = new EmbedBuilder()
    .setTitle(`${target.username}'s Avatar`)
    .setImage(target.displayAvatarURL({ size: 4096 }))
    .setColor(0xff7aa8);

  await message.channel.send({ embeds: [embed] });
}

async function sendLastfmNowPlaying(message, args) {
  const username = args[1] || lastfmUsers?.[message.author.id];

  if (!process.env.LASTFM_API_KEY) {
    await message.reply('Last.fm is not set up yet. Add `LASTFM_API_KEY` to your environment variables.');
    return;
  }

  if (!username) {
    await message.reply(`Use: \`${PREFIX}setfm your_lastfm_username\` first.`);
    return;
  }

  try {
    const { data } = await axios.get('https://ws.audioscrobbler.com/2.0/', {
      params: {
        method: 'user.getrecenttracks',
        user: username,
        api_key: process.env.LASTFM_API_KEY,
        format: 'json',
        limit: 1,
      },
    });

    const track = data.recenttracks?.track?.[0];

    if (!track) {
      await message.reply(`No recent Last.fm tracks found for **${username}**.`);
      return;
    }

    const artist = track.artist?.['#text'] || 'Unknown artist';
    const song = track.name || 'Unknown song';
    const album = track.album?.['#text'] || 'Unknown album';
    const trackUrl = track.url || `https://www.last.fm/user/${encodeURIComponent(username)}`;
    const images = Array.isArray(track.image) ? track.image : [];
    const image = [...images].reverse().find(item => item['#text'])?.['#text'];
    const isNowPlaying = track['@attr']?.nowplaying === 'true';

    const embed = new EmbedBuilder()
      .setTitle(isNowPlaying ? 'Now Playing ♫' : 'Last Played ♫')
      .setURL(trackUrl)
      .setDescription(`**${song}**\nby **${artist}**\n${album}`)
      .setColor(0xff7aa8)
      .setFooter({ text: `Last.fm • ${username}` })
      .setTimestamp();

    if (image) {
      embed.setThumbnail(image);
    }

    await message.channel.send({ embeds: [embed] });
  } catch (err) {
    logger.error('Failed to fetch Last.fm data', err);
    await message.reply('Could not fetch Last.fm data. Make sure the username is correct.');
  }
}

async function sendLastfmRecent(message, args) {
  const username = lastfmUsers?.[message.author.id];

  if (!username) {
    await message.reply(`Use: \`${PREFIX}setfm your_lastfm_username\` first.`);
    return;
  }

  const limit = Math.min(parseInt(args[1], 10) || 5, 10);

  try {
    const { data } = await axios.get('https://ws.audioscrobbler.com/2.0/', {
      params: {
        method: 'user.getrecenttracks',
        user: username,
        api_key: process.env.LASTFM_API_KEY,
        format: 'json',
        limit,
      },
    });

    const tracks = data.recenttracks?.track || [];

    const embed = new EmbedBuilder()
      .setTitle(`${username}'s Recent Tracks`)
      .setDescription(
        tracks.map((t, i) => `${i + 1}. **${t.name}** — ${t.artist?.['#text'] || 'Unknown Artist'}`).join('\n')
      )
      .setColor(0xff7aa8);

    await message.channel.send({ embeds: [embed] });
  } catch (err) {
    logger.error('Last.fm recent failed', err);
    await message.reply('Could not fetch recent tracks.');
  }
}

async function sendLastfmProfile(message) {
  const username = lastfmUsers?.[message.author.id];

  if (!username) {
    await message.reply(`Use: \`${PREFIX}setfm your_lastfm_username\` first.`);
    return;
  }

  try {
    const { data } = await axios.get('https://ws.audioscrobbler.com/2.0/', {
      params: {
        method: 'user.getinfo',
        user: username,
        api_key: process.env.LASTFM_API_KEY,
        format: 'json',
      },
    });

    const user = data.user;

    const embed = new EmbedBuilder()
      .setTitle(`${user.name}'s Last.fm Profile`)
      .setURL(user.url)
      .addFields(
        { name: 'Scrobbles', value: `${user.playcount || 0}`, inline: true },
        { name: 'Country', value: user.country || 'Unknown', inline: true }
      )
      .setColor(0xff7aa8);

    await message.channel.send({ embeds: [embed] });
  } catch (err) {
    logger.error('Last.fm profile failed', err);
    await message.reply('Could not fetch Last.fm profile.');
  }
}

async function sendLastfmTopArtists(message, args) {
  const username = lastfmUsers?.[message.author.id];

  if (!username) {
    await message.reply(`Use: \`${PREFIX}setfm your_lastfm_username\` first.`);
    return;
  }

  const periodArg = (args[1] || 'w').toLowerCase();
  const periodMap = {
    w: '7day',
    week: '7day',
    weekly: '7day',
    m: '1month',
    month: '1month',
    monthly: '1month',
    a: 'overall',
    all: 'overall',
    alltime: 'overall',
    overall: 'overall',
  };

  try {
    const { data } = await axios.get('https://ws.audioscrobbler.com/2.0/', {
      params: {
        method: 'user.gettopartists',
        user: username,
        api_key: process.env.LASTFM_API_KEY,
        format: 'json',
        period: periodMap[periodArg] || '7day',
        limit: 10,
      },
    });

    const artists = data.topartists?.artist || [];

    const embed = new EmbedBuilder()
      .setTitle(`${username}'s Top Artists (${getLastfmPeriodLabel(periodArg)})`)
      .setDescription(
        artists.map((a, i) => `${i + 1}. **${a.name}** — ${a.playcount} plays`).join('\n')
      )
      .setColor(0xff7aa8);

    await message.channel.send({ embeds: [embed] });
  } catch (err) {
    logger.error('Last.fm top artists failed', err);
    await message.reply('Could not fetch top artists.');
  }
}

function getLastfmPeriod(periodArg) {
  const periodMap = {
    w: '7day',
    week: '7day',
    weekly: '7day',
    m: '1month',
    month: '1month',
    monthly: '1month',
    a: 'overall',
    all: 'overall',
    alltime: 'overall',
    overall: 'overall',
  };

  return periodMap[(periodArg || 'weekly').toLowerCase()] || '7day';
}

function getLastfmPeriodLabel(periodArg) {
  const labelMap = {
    w: 'weekly',
    week: 'weekly',
    weekly: 'weekly',
    m: 'monthly',
    month: 'monthly',
    monthly: 'monthly',
    a: 'alltime',
    all: 'alltime',
    alltime: 'alltime',
    overall: 'alltime',
  };

  return labelMap[(periodArg || 'weekly').toLowerCase()] || 'weekly';
}

async function sendLastfmTopTracks(message, args) {
  const username = lastfmUsers?.[message.author.id];

  if (!username) {
    await message.reply(`Use: \`${PREFIX}setfm your_lastfm_username\` first.`);
    return;
  }

  const period = getLastfmPeriod(args[1] || 'w');
  const periodLabel = getLastfmPeriodLabel(args[1] || 'w');

  try {
    const { data } = await axios.get('https://ws.audioscrobbler.com/2.0/', {
      params: {
        method: 'user.gettoptracks',
        user: username,
        api_key: process.env.LASTFM_API_KEY,
        format: 'json',
        period,
        limit: 10,
      },
    });

    const tracks = data.toptracks?.track || [];

    if (!tracks.length) {
      await message.reply(`No top tracks found for **${username}**.`);
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`${username}'s Top Tracks (${periodLabel})`)
      .setDescription(
        tracks.map((t, i) => `${i + 1}. **${t.name}** — ${t.artist?.name || 'Unknown Artist'} • ${t.playcount} plays`).join('\n')
      )
      .setColor(0xff7aa8);

    await message.channel.send({ embeds: [embed] });
  } catch (err) {
    logger.error('Last.fm top tracks failed', err);
    await message.reply('Could not fetch top tracks.');
  }
}

async function sendLastfmTopAlbums(message, args) {
  const username = lastfmUsers?.[message.author.id];

  if (!username) {
    await message.reply(`Use: \`${PREFIX}setfm your_lastfm_username\` first.`);
    return;
  }

  const period = getLastfmPeriod(args[1] || 'w');
  const periodLabel = getLastfmPeriodLabel(args[1] || 'w');

  try {
    const { data } = await axios.get('https://ws.audioscrobbler.com/2.0/', {
      params: {
        method: 'user.gettopalbums',
        user: username,
        api_key: process.env.LASTFM_API_KEY,
        format: 'json',
        period,
        limit: 10,
      },
    });

    const albums = data.topalbums?.album || [];

    if (!albums.length) {
      await message.reply(`No top albums found for **${username}**.`);
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`${username}'s Top Albums (${periodLabel})`)
      .setDescription(
        albums.map((a, i) => `${i + 1}. **${a.name}** — ${a.artist?.name || 'Unknown Artist'} • ${a.playcount} plays`).join('\n')
      )
      .setColor(0xff7aa8);

    const images = Array.isArray(albums[0]?.image) ? albums[0].image : [];
    const image = [...images].reverse().find(item => item['#text'])?.['#text'];

    if (image) {
      embed.setThumbnail(image);
    }

    await message.channel.send({ embeds: [embed] });
  } catch (err) {
    logger.error('Last.fm top albums failed', err);
    await message.reply('Could not fetch top albums.');
  }
}

async function fetchLastfmTopArtists(username, limit = 50) {
  const { data } = await axios.get('https://ws.audioscrobbler.com/2.0/', {
    params: {
      method: 'user.gettopartists',
      user: username,
      api_key: process.env.LASTFM_API_KEY,
      format: 'json',
      period: 'overall',
      limit,
    },
  });

  return data.topartists?.artist || [];
}

async function sendLastfmTaste(message) {
  const username = lastfmUsers?.[message.author.id];
  const target = message.mentions.users.first();
  const targetUsername = target ? lastfmUsers?.[target.id] : null;

  if (!username) {
    await message.reply(`Use: \`${PREFIX}setfm your_lastfm_username\` first.`);
    return;
  }

  if (!target) {
    await message.reply(`Use: \`${PREFIX}taste @user\``);
    return;
  }

  if (!targetUsername) {
    await message.reply(`${target} has not saved their Last.fm yet.`);
    return;
  }

  try {
    const [yourArtists, theirArtists] = await Promise.all([
      fetchLastfmTopArtists(username, 50),
      fetchLastfmTopArtists(targetUsername, 50),
    ]);

    const theirArtistNames = new Set(theirArtists.map(artist => artist.name.toLowerCase()));
    const common = yourArtists.filter(artist => theirArtistNames.has(artist.name.toLowerCase())).slice(0, 10);
    const score = Math.round((common.length / 50) * 100);

    const compatibility = score >= 50 ? 'Super Compatibility' : score >= 25 ? 'Good Compatibility' : score >= 10 ? 'Low Compatibility' : 'Very Low Compatibility';

    const embed = new EmbedBuilder()
      .setTitle(`${message.author.username} 🤝 ${target.username}`)
      .setDescription(
        `**${compatibility}** — ${score}%\n\n` +
        (common.length
          ? `**Common Artists**\n${common.map(artist => `• ${artist.name}`).join('\n')}`
          : 'No common top artists found.')
      )
      .setColor(0xff7aa8)
      .setFooter({ text: `${username} × ${targetUsername}` });

    await message.channel.send({ embeds: [embed] });
  } catch (err) {
    logger.error('Last.fm taste failed', err);
    await message.reply('Could not compare music taste.');
  }
}

async function fetchLastfmArtistPlaycount(username, artistName) {
  const { data } = await axios.get('https://ws.audioscrobbler.com/2.0/', {
    params: {
      method: 'artist.getinfo',
      artist: artistName,
      username,
      api_key: process.env.LASTFM_API_KEY,
      format: 'json',
    },
  });

  return parseInt(data.artist?.stats?.userplaycount || '0', 10) || 0;
}

async function sendLastfmWhoKnows(message, args) {
  const artistName = args.slice(1).join(' ').trim();

  if (!artistName) {
    await message.reply(`Use: \`${PREFIX}whoknows artist name\``);
    return;
  }

  const entries = Object.entries(lastfmUsers || {});

  if (!entries.length) {
    await message.reply('No saved Last.fm users yet.');
    return;
  }

  try {
    const guildMembers = await message.guild.members.fetch().catch(() => null);

    const leaderboard = await Promise.all(entries.map(async ([discordId, username]) => {
      const playcount = await fetchLastfmArtistPlaycount(username, artistName).catch(() => 0);
      const member = guildMembers?.get(discordId);

      return {
        discordId,
        username,
        displayName: member?.displayName || username,
        playcount,
      };
    }));

    const sorted = leaderboard
      .filter(item => item.playcount > 0)
      .sort((a, b) => b.playcount - a.playcount)
      .slice(0, 10);

    if (!sorted.length) {
      await message.reply(`Nobody with a saved Last.fm has scrobbled **${artistName}**.`);
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`Who Knows ${artistName}?`)
      .setDescription(
        sorted.map((item, i) => `${i + 1}. **${item.displayName}** — ${item.playcount} plays`).join('\n')
      )
      .setColor(0xff7aa8);

    await message.channel.send({ embeds: [embed] });
  } catch (err) {
    logger.error('Last.fm whoknows failed', err);
    await message.reply('Could not build the Who Knows leaderboard.');
  }
}

function isStaffModerator(message, permissionFlag) {
  const hasStaffRole = message.member.roles.cache.has(STAFF_ROLE_ID);
  const hasPermission = permissionFlag
    ? message.member.permissions?.has(permissionFlag) || message.member.permissions?.has(PermissionsBitField.Flags.Administrator)
    : false;

  return hasStaffRole || hasPermission;
}

async function kickUser(message, args) {
  if (!isStaffModerator(message, PermissionsBitField.Flags.KickMembers)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const target = message.mentions.members.first();

  if (!target) {
    await message.reply(`Use: \`${PREFIX}kick @user reason\``);
    return;
  }

  if (!target.kickable) {
    await message.reply('I cannot kick this user. Check my role position and permissions.');
    return;
  }

  const reason = args.slice(2).join(' ') || 'No reason provided';

  await target.kick(reason);
  await message.channel.send(`👢 Kicked **${target.user.tag}**. Reason: ${reason}`);
}

async function banUser(message, args) {
  if (!isStaffModerator(message, PermissionsBitField.Flags.BanMembers)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  let target = message.mentions.members.first();

  if (!target && args[1]) {
    target = await message.guild.members.fetch(args[1]).catch(() => null);
  }

  if (!target) {
    await message.reply(`Use: \`${PREFIX}ban @user reason\` or \`${PREFIX}ban userID reason\``);
    return;
  }

  if (!target.bannable) {
    await message.reply('I cannot ban this user. Check my role position and permissions.');
    return;
  }

  const reason = args.slice(2).join(' ') || 'No reason provided';

  await target.ban({ reason });
  await message.channel.send(`🔨 Banned **${target.user.tag}**. Reason: ${reason}`);
}

async function unbanUser(message, args) {
  if (!isStaffModerator(message, PermissionsBitField.Flags.BanMembers)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const userId = args[1];

  if (!userId) {
    await message.reply(`Use: \`${PREFIX}unban userID reason\``);
    return;
  }

  const reason = args.slice(2).join(' ') || 'No reason provided';

  try {
    await message.guild.members.unban(userId, reason);
    await message.channel.send(`✅ Unbanned **${userId}**. Reason: ${reason}`);
  } catch (err) {
    logger.error('Failed to unban user', err);
    await message.reply('Could not unban that user. Make sure the ID is correct and they are banned.');
  }
}

async function purgeUserMessages(message, args) {
  if (!isStaffModerator(message, PermissionsBitField.Flags.ManageMessages)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const target = message.mentions.users.first();
  const amount = parseInt(args[2], 10);

  if (!target || !Number.isInteger(amount) || amount < 1 || amount > 99) {
    await message.reply(`Use: \`${PREFIX}purgeuser @user amount\` — amount must be between **1** and **99**.`);
    return;
  }

  const botMember = message.guild.members.me;
  const botCanManageMessages = botMember?.permissionsIn(message.channel).has(PermissionsBitField.Flags.ManageMessages);

  if (!botCanManageMessages) {
    await message.reply('I need the **Manage Messages** permission to purge messages here.');
    return;
  }

  try {
    const fetched = await message.channel.messages.fetch({ limit: 100 });
    const userMessages = fetched
      .filter(msg => msg.author.id === target.id)
      .first(amount);

    if (userMessages.length === 0) {
      await message.reply(`No recent messages found from ${target}.`);
      return;
    }

    const deleted = await message.channel.bulkDelete(userMessages, true);
    const reply = await message.channel.send(`✅ Purged **${deleted.size}** recent message(s) from ${target}.`);

    setTimeout(() => {
      reply.delete().catch(() => null);
    }, 5000);
  } catch (err) {
    logger.error('Failed to purge user messages', err);
    await message.channel.send('❌ Could not purge those messages. Messages older than 14 days cannot be bulk deleted.');
  }
}

async function addRoleToUser(message) {
  if (!isStaffModerator(message, PermissionsBitField.Flags.ManageRoles)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const target = message.mentions.members.first();
  const role = message.mentions.roles.first();

  if (!target || !role) {
    await message.reply(`Use: \`${PREFIX}role @user @role\``);
    return;
  }

  if (!role.editable) {
    await message.reply('I cannot give that role. Make sure my role is above it.');
    return;
  }

  await target.roles.add(role, `Role added by ${message.author.tag}`);
  await message.channel.send(`✅ Added ${role} to ${target}.`);
}

async function removeRoleFromUser(message) {
  if (!isStaffModerator(message, PermissionsBitField.Flags.ManageRoles)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const target = message.mentions.members.first();
  const role = message.mentions.roles.first();

  if (!target || !role) {
    await message.reply(`Use: \`${PREFIX}removerole @user @role\``);
    return;
  }

  if (!role.editable) {
    await message.reply('I cannot remove that role. Make sure my role is above it.');
    return;
  }

  await target.roles.remove(role, `Role removed by ${message.author.tag}`);
  await message.channel.send(`✅ Removed ${role} from ${target}.`);
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

async function handleStickyMessageCommand(message, args) {
  if (!isStaffModerator(message, PermissionsBitField.Flags.ManageMessages)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const subcommand = args[1]?.toLowerCase();

  if (subcommand === 'add') {
    await addStickyMessage(message);
    return;
  }

  if (subcommand === 'list') {
    await listStickyMessages(message);
    return;
  }

  if (subcommand === 'view') {
    await viewStickyMessage(message);
    return;
  }

  if (subcommand === 'remove') {
    await removeStickyMessage(message);
    return;
  }

  await message.reply(
    `Use: \`${PREFIX}stickymessage add #channel message\`\n` +
    `\`${PREFIX}stickymessage list\`\n` +
    `\`${PREFIX}stickymessage view #channel\`\n` +
    `\`${PREFIX}stickymessage remove #channel\``
  );
}

async function addStickyMessage(message) {
  const channel = message.mentions.channels.first();

  if (!channel) {
    await message.reply(`Use: \`${PREFIX}stickymessage add #channel message\``);
    return;
  }

  const stickyText = message.content
    .slice(`${PREFIX}stickymessage add`.length)
    .replace(`<#${channel.id}>`, '')
    .trim();

  if (!stickyText) {
    await message.reply(`Use: \`${PREFIX}stickymessage add #channel message\``);
    return;
  }

  stickyMessages[channel.id] = {
    channelId: channel.id,
    content: stickyText,
    createdBy: message.author.id,
    updatedAt: new Date().toISOString(),
  };

  saveStickyMessages();

  if (supabase.saveStickyMessage) {
    await supabase.saveStickyMessage(channel.id, stickyMessages[channel.id])
      .catch(err => logger.error('Failed to save sticky to Supabase', err));
  }

  await message.reply(`✅ Sticky message saved for ${channel}.`);
}

async function listStickyMessages(message) {
  const entries = Object.values(stickyMessages);

  if (entries.length === 0) {
    await message.reply('No sticky messages are currently configured.');
    return;
  }

  const lines = entries.map((sticky, index) => {
    const preview = sticky.content.length > 75
      ? `${sticky.content.slice(0, 75)}...`
      : sticky.content;

    return `**${index + 1}.** <#${sticky.channelId}> — ${preview}`;
  });

  const embed = new EmbedBuilder()
    .setTitle('📌 Sticky Messages')
    .setDescription(lines.join('\n'))
    .setColor(0xff7aa8)
    .setTimestamp();

  await message.channel.send({ embeds: [embed] });
}

async function viewStickyMessage(message) {
  const channel = message.mentions.channels.first();

  if (!channel) {
    await message.reply(`Use: \`${PREFIX}stickymessage view #channel\``);
    return;
  }

  const sticky = stickyMessages[channel.id];

  if (!sticky) {
    await message.reply(`No sticky message is configured for ${channel}.`);
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('📌 Sticky Message')
    .addFields(
      { name: 'Channel', value: `${channel}`, inline: false },
      { name: 'Content', value: sticky.content.slice(0, 1024), inline: false }
    )
    .setColor(0xff7aa8)
    .setTimestamp();

  await message.channel.send({ embeds: [embed] });
}


async function removeStickyMessage(message) {
  const channel = message.mentions.channels.first();

  if (!channel) {
    await message.reply(`Use: \`${PREFIX}stickymessage remove #channel\``);
    return;
  }

  if (!stickyMessages[channel.id]) {
    await message.reply(`No sticky message is configured for ${channel}.`);
    return;
  }

  delete stickyMessages[channel.id];
  saveStickyMessages();

  if (supabase.deleteStickyMessage) {
    await supabase.deleteStickyMessage(channel.id)
      .catch(err => logger.error('Failed to delete sticky from Supabase', err));
  }

  await message.reply(`✅ Removed sticky message from ${channel}.`);
}

async function testStickySupabase(message) {
  if (!isStaffModerator(message, PermissionsBitField.Flags.ManageMessages)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  if (!supabase.saveStickyMessage) {
    await message.reply('❌ saveStickyMessage() is not available.');
    return;
  }

  try {
    const result = await supabase.saveStickyMessage('test-channel', {
      content: 'Sticky Supabase test',
      createdBy: message.author.id,
      stickyMessageId: 'test-message',
    });

    await message.reply(`✅ Supabase test completed. Result: ${JSON.stringify(result)}`);
  } catch (err) {
    logger.error('Sticky Supabase test failed', err);
    await message.reply(`❌ Supabase test failed: ${err.message}`);
  }
}

async function handleStickyMessageActivity(message) {
  if (!message.guild) return;

  const sticky = stickyMessages[message.channel.id];
  if (!sticky) return;

  if (sticky.lastMessageId === message.id) return;

  try {
    if (sticky.stickyMessageId) {
      const oldMessage = await message.channel.messages.fetch(sticky.stickyMessageId).catch(() => null);
      if (oldMessage) {
        await oldMessage.delete().catch(() => null);
      }
    }

    const sent = await message.channel.send(sticky.content);

    sticky.stickyMessageId = sent.id;
    sticky.lastMessageId = message.id;

    saveStickyMessages();
    if (supabase.saveStickyMessage) {
      await supabase.saveStickyMessage(message.channel.id, sticky)
        .catch(err => logger.error('Failed to update sticky message ID in Supabase', err));
    }
  } catch (err) {
    logger.error('Failed to post sticky message', err);
  }
}

async function handleAutoresponderCommand(message, args) {
  if (!isStaffModerator(message, PermissionsBitField.Flags.ManageMessages)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const subcommand = args[1]?.toLowerCase();

  if (subcommand === 'add') {
    const content = message.content.slice(`${PREFIX}autoresponder add`.length).trim() || message.content.slice(`${PREFIX}ar add`.length).trim();
    const parts = content.split('|').map(part => part.trim());
    const trigger = parts[0]?.toLowerCase();
    const response = parts.slice(1).join('|').trim();

    if (!trigger || !response) {
      await message.reply(`Use: \`${PREFIX}autoresponder add trigger | response\``);
      return;
    }

    const existing = autoresponders.find(item => item.trigger === trigger);

    if (existing) {
      existing.response = response;
      existing.updatedBy = message.author.id;
      existing.updatedAt = new Date().toISOString();
    } else {
      autoresponders.push({
        trigger,
        response,
        createdBy: message.author.id,
        createdAt: new Date().toISOString(),
      });
    }

    saveAutoresponders();
    await message.reply(`✅ Autoresponder saved for \`${trigger}\`.`);
    return;
  }

  if (subcommand === 'list') {
    if (!autoresponders.length) {
      await message.reply('No autoresponders are set up yet.');
      return;
    }

    const lines = autoresponders.slice(0, 25).map((item, index) => {
      const preview = item.response.length > 80 ? `${item.response.slice(0, 77)}...` : item.response;
      return `**${index + 1}.** \`${item.trigger}\` → ${preview}`;
    });

    const embed = new EmbedBuilder()
      .setTitle('Autoresponders')
      .setDescription(lines.join('\n'))
      .setColor(0xff7aa8)
      .setTimestamp();

    await message.channel.send({ embeds: [embed] });
    return;
  }

  if (subcommand === 'remove' || subcommand === 'delete') {
    const trigger = message.content
      .slice(message.content.indexOf(subcommand) + subcommand.length)
      .trim()
      .toLowerCase();

    if (!trigger) {
      await message.reply(`Use: \`${PREFIX}autoresponder remove trigger\``);
      return;
    }

    const oldLength = autoresponders.length;
    autoresponders = autoresponders.filter(item => item.trigger !== trigger);

    if (autoresponders.length === oldLength) {
      await message.reply(`No autoresponder found for \`${trigger}\`.`);
      return;
    }

    saveAutoresponders();
    await message.reply(`✅ Removed autoresponder for \`${trigger}\`.`);
    return;
  }

  await message.reply(
    `Use:\n` +
    `\`${PREFIX}autoresponder add trigger | response\`\n` +
    `\`${PREFIX}autoresponder list\`\n` +
    `\`${PREFIX}autoresponder remove trigger\``
  );
}

async function handleAutoresponder(message) {
  if (!message.guild) return;
  if (!autoresponders.length) return;
  if (message.content.startsWith(PREFIX)) return;

  const content = message.content.trim().toLowerCase();
  if (!content) return;

  const match = autoresponders.find(item => content === item.trigger);
  if (!match) return;

  const response = match.response
    .replaceAll('{user}', `${message.author}`)
    .replaceAll('{user.name}', message.author.username)
    .replaceAll('{server}', message.guild.name)
    .replaceAll('{channel}', `${message.channel}`);

  await message.channel.send(response);
}

async function sendTweetPost(message, args) {
  if (!message.member.roles.cache.has(STAFF_ROLE_ID)) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  const content = args.slice(1).join(' ').trim();
  const presetName = args[1]?.toLowerCase();
  const mentionedChannel = message.mentions.channels.first();
  const presetChannelId = presetName ? channelPresets?.[presetName] : null;
  const presetChannel = presetChannelId ? await message.guild.channels.fetch(presetChannelId).catch(() => null) : null;
  const targetChannel = mentionedChannel || presetChannel;
  const tweetUrls = (content.match(/https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^\s]+/gi) || []).map(normalizeTweetUrl);

  if (!targetChannel || tweetUrls.length === 0) {
    await message.reply(
      `Use: \`${PREFIX}tweetpost #channel tweetLink\` or \`${PREFIX}tp preset tweetLink\`\n` +
      `Save presets with: \`${PREFIX}channelpreset set name #channel\``
    );
    return;
  }
  let sentCount = 0;

  for (const tweetUrl of tweetUrls) {
    const tweetInfo = parseTweetUrl(tweetUrl);

    if (!tweetInfo.statusId) {
      continue;
    }

    const tweetDetails = await fetchTweetDetails(tweetInfo.statusId).catch(err => {
      logger.warn('Failed to fetch tweet details for manual tweetpost', err);
      return null;
    });

    const mediaFiles = getTweetMediaFiles(tweetDetails);

    if (!mediaFiles.length) {
      continue;
    }

    for (const file of mediaFiles) {
      await targetChannel.send({
        files: [file],
      });

      sentCount += 1;
    }
  }

  if (targetChannel.id !== message.channel.id) {
    await message.reply(`✅ Sent ${sentCount} tweet media file(s) to ${targetChannel}.`);
  } else {
    await message.react(sentCount > 0 ? '✅' : '❌').catch(() => null);
  }
}

function getTweetMediaFiles(tweetDetails) {
  const tweet = tweetDetails?.tweet || tweetDetails;
  const media = tweet?.media || tweetDetails?.media || {};
  const files = [];

  const addFile = (url, name) => {
    if (!url || files.some(file => file.attachment === url)) return;

    files.push({
      attachment: url,
      name,
    });
  };

  if (Array.isArray(media.all)) {
    media.all.forEach((item, index) => {
      const videoUrl = item.url || item.video_url || item.videoUrl;
      const imageUrl = item.url || item.image_url || item.imageUrl;
      const type = item.type || '';

      if (type.includes('video') || videoUrl?.includes('.mp4')) {
        addFile(videoUrl, `tweet-video-${index + 1}.mp4`);
      } else {
        addFile(imageUrl, `tweet-image-${index + 1}.jpg`);
      }
    });
  }

  if (Array.isArray(media.photos)) {
    media.photos.forEach((photo, index) => {
      addFile(photo.url || photo.image_url || photo.imageUrl, `tweet-image-${index + 1}.jpg`);
    });
  }

  if (Array.isArray(media.videos)) {
    media.videos.forEach((video, index) => {
      addFile(video.url || video.video_url || video.videoUrl, `tweet-video-${index + 1}.mp4`);
    });
  }

  addFile(media.videoUrl || media.video_url, 'tweet-video.mp4');
  addFile(media.imageUrl || media.image_url, 'tweet-image.jpg');

  return files;
}

function normalizeTweetUrl(url) {
  return url
    .replace('twitter.com', 'x.com')
    .replace(/[)>.,]+$/g, '')
    .split('?')[0];
}

function parseTweetUrl(url) {
  const normalized = normalizeTweetUrl(url);
  const match = normalized.match(/x\.com\/([^\/\s]+)\/status\/([0-9]+)/i);

  return {
    username: match?.[1] || null,
    statusId: match?.[2] || null,
  };
}

async function fetchTweetDetails(statusId) {
  const fxResponse = await fetch(`https://api.fxtwitter.com/status/${statusId}`, {
    headers: {
      'User-Agent': 'fvgify-discord-bot/1.0',
      Accept: 'application/json',
    },
  }).catch(err => null);
  if (!fxResponse || !fxResponse.ok) {
    return {};
  }
  const data = await fxResponse.json();
  // Compose media with all, photos, videos, plus imageUrl/videoUrl for legacy compatibility
  const tweet = data.tweet || data;
  const media = tweet.media || {};
  const photos = Array.isArray(media.photos) ? media.photos : [];
  const videos = Array.isArray(media.videos) ? media.videos : [];
  const all = Array.isArray(media.all) ? media.all : [];

  return {
    tweet,
    media: {
      ...media,
      photos,
      videos,
      all,
      imageUrl: photos[0]?.url || photos[0]?.image_url || media.imageUrl || media.image_url || null,
      videoUrl: videos[0]?.url || videos[0]?.video_url || media.videoUrl || media.video_url || null,
    },
  };
}

if (!config.DISCORD_TOKEN) {
  logger.error('Missing DISCORD_TOKEN.');
  process.exit(1);
}

client.login(config.DISCORD_TOKEN).catch((err) => {
  logger.error('Failed to login to Discord', err);
  process.exit(1);
});