require('dotenv').config();
const path = require('path');

const getEnv = (key, fallback = null) => process.env[key] || fallback;

module.exports = {
  PREFIX: getEnv('PREFIX', '.'),
  GUILD_ID: getEnv('GUILD_ID', '1503876779369173263'),
  STAFF_ROLE_ID: getEnv('STAFF_ROLE_ID', '1508178939489685624'),
  VERIFY_CATEGORY_ID: getEnv('VERIFY_CATEGORY_ID', '1510877767229767845'),
  MOD_APP_CATEGORY_ID: getEnv('MOD_APP_CATEGORY_ID', '1510921080267866142'),
  MOD_APP_LOG_CHANNEL_ID: getEnv('MOD_APP_LOG_CHANNEL_ID', null),
  BOOSTER_ROLE_IDS: (getEnv('BOOSTER_ROLE_IDS') || '1509295991906369658,1509166982656950292').split(',').map(s => s.trim()),
  BOOST_LOG_CHANNEL_ID: getEnv('BOOST_LOG_CHANNEL_ID', '1510874261575700501'),
  BOOST_DATA_FILE: getEnv('BOOST_DATA_FILE', path.join(__dirname, 'boosts.json')),
  SUPABASE_URL: getEnv('SUPABASE_URL', null),
  SUPABASE_KEY: getEnv('SUPABASE_KEY', null),
  SUPABASE_BOOSTER_TABLE: getEnv('SUPABASE_BOOSTER_TABLE', 'booster_list'),
  SUPABASE_AUTO_SYNC: getEnv('SUPABASE_AUTO_SYNC', 'false'),
  DISCORD_TOKEN: getEnv('DISCORD_TOKEN', getEnv('BOT_TOKEN', getEnv('TOKEN', null))),
};
