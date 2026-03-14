const mongoose = require('mongoose');
const ShippingRule = require('./models/ShippingRule');
require('dotenv').config();

mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGO_DB_NAME }).then(async () => {
    const rules = await ShippingRule.find({});
    console.log("RULES:", JSON.stringify(rules, null, 2));
    process.exit(0);
}).catch(err => {
    console.error(err);
    process.exit(1);
});
