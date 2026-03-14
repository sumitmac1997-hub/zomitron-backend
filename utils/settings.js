const Setting = require('../models/Setting');

const getSettingValue = async (key, defaultValue) => {
    const setting = await Setting.findOne({ key }).lean();
    return setting?.value ?? defaultValue;
};

const setSettingValue = async (key, value, userId) => {
    const setting = await Setting.findOneAndUpdate(
        { key },
        { value, updatedBy: userId },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    return setting;
};

module.exports = {
    getSettingValue,
    setSettingValue,
};
