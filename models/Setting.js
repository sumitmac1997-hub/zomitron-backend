const mongoose = require('mongoose');

const settingSchema = new mongoose.Schema(
    {
        key: { type: String, required: true, unique: true, trim: true },
        value: mongoose.Schema.Types.Mixed,
        description: String,
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },
    { timestamps: true }
);

module.exports = mongoose.model('Setting', settingSchema);
