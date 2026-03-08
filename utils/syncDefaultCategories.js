const Category = require('../models/Category');
const { DEFAULT_CATEGORIES } = require('../constants/defaultCategories');

let syncPromise;

const syncDefaultCategories = async () => {
    if (syncPromise) return syncPromise;

    syncPromise = (async () => {
        const existing = await Category.find({ slug: { $in: DEFAULT_CATEGORIES.map((c) => c.slug) } })
            .select('_id slug')
            .lean();

        const existingSlugs = new Set(existing.map((c) => c.slug));

        const missing = DEFAULT_CATEGORIES
            .filter((c) => !existingSlugs.has(c.slug))
            .map((category) => ({ ...category, isActive: true, parent: null }));

        if (missing.length > 0) {
            await Category.insertMany(missing, { ordered: false });
        }

        await Promise.all(
            DEFAULT_CATEGORIES.map((category) =>
                Category.updateOne(
                    { slug: category.slug },
                    {
                        $set: {
                            name: category.name,
                            icon: category.icon,
                            themeColor: category.themeColor,
                            sortOrder: category.sortOrder,
                            isActive: true,
                            parent: null,
                        },
                    }
                )
            )
        );
    })();

    try {
        await syncPromise;
    } finally {
        syncPromise = null;
    }
};

module.exports = { syncDefaultCategories };
