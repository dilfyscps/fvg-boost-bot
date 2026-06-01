const { createClient } = require('@supabase/supabase-js');
const config = require('./config');
const logger = require('./logger');

const {
  SUPABASE_URL,
  SUPABASE_KEY,
  SUPABASE_BOOSTER_TABLE,
} = config;

const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
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

module.exports = {
  isSupabaseConfigured,
  saveBoosterList,
  loadBoosterList,
};
