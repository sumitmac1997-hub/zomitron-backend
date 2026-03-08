const mongoose = require('mongoose');

const pincodeSchema = new mongoose.Schema(
    {
        pincode: { type: String, required: true, unique: true, match: [/^\d{6}$/, 'Pincode must be 6 digits'] },
        city: { type: String, required: true },
        district: String,
        state: { type: String, required: true },
        country: { type: String, default: 'India' },
        lat: { type: Number, required: true },
        lng: { type: Number, required: true },
        location: {
            type: { type: String, enum: ['Point'], default: 'Point' },
            coordinates: [Number], // [lng, lat]
        },
        taluk: String,
        officeName: String,
    },
    { timestamps: false }
);

pincodeSchema.index({ pincode: 1 }, { unique: true });
pincodeSchema.index({ location: '2dsphere' });
pincodeSchema.index({ city: 1 });
pincodeSchema.index({ state: 1 });

// Auto-set location from lat/lng
pincodeSchema.pre('save', function (next) {
    if (this.lat && this.lng) {
        this.location = { type: 'Point', coordinates: [this.lng, this.lat] };
    }
    next();
});

module.exports = mongoose.model('Pincode', pincodeSchema);
