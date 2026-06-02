const { createClient } = require('@supabase/supabase-js');
const config = require('./config');
const logger = require('./logger');
const WebSocket = require('ws');

const {
  SUPABASE_URL,
  SUPABASE_KEY,
  SUPABASE_BOOSTER_TABLE,
  SUPABASE_STICKY_TABLE,
} = config;

const STICKY_TABLE = SUPABASE_STICKY_TABLE || process.env.SUPABASE_STICKY_TABLE || 'sticky_messages';

const AUTORESPONDERS_TABLE = process.env.SUPABASE_AUTORESPONDERS_TABLE || 'autoresponders';

const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY, {
      realtime: {
        transport: WebSocket,
      },
    })
  : null;

function isSupabaseConfigured() {
  return Boolean(supabase && SUPABASE_BOOSTER_TABLE);
}

async function saveBoosterList(boostData) {
  if (!isSupabaseConfigured()) {
    logger.warn('Supabase is not configured. Skipping booster save.');
    return { count: 0 };
  }

  const boosters = Object.entries(boostData)
    .filter(([, data]) => data && data.verifiedBoosts > 0)
    .map(([userId, data]) => ({
      user_id: userId,
      username: data.username || null,
      boosts: data.boosts || 0,
      verified_boosts: data.verifiedBoosts || 0,
      verified: Boolean(data.verified),
      verified_at: data.verifiedAt ? new Date(data.verifiedAt).toISOString() : null,
      verified_by: data.verifiedBy || null,
      last_boosted_at: data.lastBoostedAt ? new Date(data.lastBoostedAt).toISOString() : null,
      lost_boost_alerted: Boolean(data.lostBoostAlerted),
    }));

  if (boosters.length === 0) {
    return { count: 0 };
  }

  const { error } = await supabase
    .from(SUPABASE_BOOSTER_TABLE)
    .upsert(boosters, { onConflict: 'user_id' });

  if (error) {
    logger.error('Supabase saveBoosterList failed', error);
    throw error;
  }

  return { count: boosters.length };
}

async function loadBoosterList() {
  if (!isSupabaseConfigured()) {
    logger.warn('Supabase is not configured. Skipping booster load.');
    return [];
  }

  const { data, error } = await supabase
    .from(SUPABASE_BOOSTER_TABLE)
    .select('*');

  if (error) {
    logger.error('Supabase loadBoosterList failed', error);
    throw error;
  }

  return Array.isArray(data) ? data : [];
}

async function loadStickyMessages() {
  if (!supabase) {
    logger.warn('Supabase is not configured. Skipping sticky message load.');
    return {};
  }

  const { data, error } = await supabase
    .from(STICKY_TABLE)
    .select('*');

  if (error) {
    logger.error('Supabase loadStickyMessages failed', error);
    throw error;
  }

  const result = {};

  for (const row of data || []) {
    result[row.channel_id] = {
      channelId: row.channel_id,
      content: row.content,
      stickyMessageId: row.sticky_message_id,
      createdBy: row.created_by,
      updatedAt: row.updated_at,
    };
  }

  return result;
}

async function saveStickyMessage(channelId, sticky) {
  if (!supabase) {
    logger.warn('Supabase is not configured. Skipping sticky message save.');
    return { saved: false, reason: 'Supabase is not configured.' };
  }

  const { error } = await supabase
    .from(STICKY_TABLE)
    .upsert({
      channel_id: channelId,
      content: sticky.content,
      sticky_message_id: sticky.stickyMessageId || null,
      created_by: sticky.createdBy || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'channel_id' });

  if (error) {
    logger.error('Supabase saveStickyMessage failed', error);
    throw error;
  }

  return { saved: true };
}

async function deleteStickyMessage(channelId) {
  if (!supabase) {
    logger.warn('Supabase is not configured. Skipping sticky message delete.');
    return { deleted: false, reason: 'Supabase is not configured.' };
  }

  const { error } = await supabase
    .from(STICKY_TABLE)
    .delete()
    .eq('channel_id', channelId);

  if (error) {
    logger.error('Supabase deleteStickyMessage failed', error);
    throw error;
  }

  return { deleted: true };

}

async function loadAutoresponders() {
  if (!supabase) {
    logger.warn('Supabase is not configured. Skipping autoresponder load.');
    return [];
  }

  const { data, error } = await supabase
    .from(AUTORESPONDERS_TABLE)
    .select('*')
    .order('created_at', { ascending: true });

  if (error) {
    logger.error('Supabase loadAutoresponders failed', error);
    throw error;
  }

  return (data || []).map(row => ({
    trigger: row.trigger,
    response: row.response,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  }));
}

async function saveAutoresponders(autoresponders) {
  if (!supabase) {
    logger.warn('Supabase is not configured. Skipping autoresponder save.');
    return { saved: false, reason: 'Supabase is not configured.' };
  }

  const rows = autoresponders.map(item => ({
    trigger: item.trigger,
    response: item.response,
    created_by: item.createdBy || null,
    created_at: item.createdAt || new Date().toISOString(),
    updated_by: item.updatedBy || null,
    updated_at: item.updatedAt || null,
  }));

  const { error: deleteError } = await supabase
    .from(AUTORESPONDERS_TABLE)
    .delete()
    .neq('trigger', '__never_delete_this__');

  if (deleteError) {
    logger.error('Supabase saveAutoresponders delete old rows failed', deleteError);
    throw deleteError;
  }

  if (!rows.length) {
    return { saved: true, count: 0 };
  }

  const { error } = await supabase
    .from(AUTORESPONDERS_TABLE)
    .upsert(rows, { onConflict: 'trigger' });

  if (error) {
    logger.error('Supabase saveAutoresponders failed', error);
    throw error;
  }

  return { saved: true, count: rows.length };
}

module.exports = {
  isSupabaseConfigured,
  saveBoosterList,
  loadBoosterList,
  loadStickyMessages,
  saveStickyMessage,
  deleteStickyMessage,
  loadAutoresponders,
  saveAutoresponders,
};
