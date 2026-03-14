const mongoose = require('mongoose');

const taxClassSchema = new mongoose.Schema(
    {
        name: { type: String, required: true },
        code: { type: String, required: true, unique: true, lowercase: true, trim: true },
        rate: { type: Number, required: true, min: 0 },
        description: String,
        priority: { type: Number, default: 1 },
        appliesToShipping: { type: Boolean, default: false },
        isCompound: { type: Boolean, default: false },
        isActive: { type: Boolean, default: true },
        countryCode: { type: String, default: 'IN' },
        stateCode: { type: String, default: 'UP' },
        city: { type: String, default: '*' },
        postcode: { type: String, default: '*' },
        taxName: { type: String, default: '' },
        metadata: { type: Map, of: String },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },
    { timestamps: true }
);

module.exports = mongoose.model('TaxClass', taxClassSchema);
