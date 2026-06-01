const fs = require('fs');

function loadBoostData(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify({}, null, 2));
    }

    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error('storage.loadBoostData failed', err);
    return {};
  }
}

function saveBoostData(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('storage.saveBoostData failed', err);
  }
}

module.exports = {
  loadBoostData,
  saveBoostData,
};
