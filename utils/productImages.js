const {
    createImageAsset,
    deleteStoredImageAsset,
    uploadBufferImage,
} = require('../config/cloudinary');
const { MAX_PRODUCT_IMAGE_COUNT } = require('../middleware/productUpload');

const buildProductImageFolder = (vendorId) => `products/${vendorId}`;

const cloneImageAsset = (asset) => {
    const normalized = createImageAsset(asset);
    return normalized ? { ...normalized } : null;
};

const cloneVariation = (variation = {}) => ({
    ...variation,
    attributes: Array.isArray(variation.attributes)
        ? variation.attributes.map((attribute) => ({ ...attribute }))
        : [],
    imageAsset: variation.imageAsset ? { ...variation.imageAsset } : undefined,
});

const dedupeAssets = (assets = []) => {
    const seen = new Set();
    return assets.reduce((list, asset) => {
        const normalized = cloneImageAsset(asset);
        if (!normalized) return list;

        const key = normalized.publicId || normalized.url;
        if (!key || seen.has(key)) return list;
        seen.add(key);
        list.push(normalized);
        return list;
    }, []);
};

const resolveSubmittedAssetsFromUrls = (urls = [], candidateAssets = []) => {
    const candidateMap = new Map(
        (Array.isArray(candidateAssets) ? candidateAssets : [])
            .map((asset) => cloneImageAsset(asset))
            .filter(Boolean)
            .map((asset) => [asset.url, asset]),
    );

    return dedupeAssets(
        (Array.isArray(urls) ? urls : [])
            .map((url) => candidateMap.get(url) || createImageAsset(url))
            .filter(Boolean),
    );
};

const orderProductAssets = ({
    uploadedAssets = [],
    existingAssets = [],
    imageOrder = [],
}) => {
    const descriptors = [
        ...existingAssets.map((asset, index) => ({ key: `url:${index}`, asset })),
        ...uploadedAssets.map((asset, index) => ({ key: `file:${index}`, asset })),
    ];

    if (descriptors.length === 0) return [];
    if (!Array.isArray(imageOrder) || imageOrder.length === 0) {
        return dedupeAssets(descriptors.map((descriptor) => descriptor.asset)).slice(0, MAX_PRODUCT_IMAGE_COUNT);
    }

    const ordered = imageOrder
        .map((itemKey) => descriptors.find((descriptor) => descriptor.key === String(itemKey)))
        .filter(Boolean);
    const orderedKeys = new Set(ordered.map((descriptor) => descriptor.key));
    const remaining = descriptors.filter((descriptor) => !orderedKeys.has(descriptor.key));

    return dedupeAssets([...ordered, ...remaining].map((descriptor) => descriptor.asset))
        .slice(0, MAX_PRODUCT_IMAGE_COUNT);
};

const promotePrimaryVariationAsset = (assets = [], variations = []) => {
    const normalizedAssets = dedupeAssets(assets);
    const primaryImageUrl = variations.find((variation) => variation?.isPrimaryImage && variation?.image)?.image;
    if (!primaryImageUrl) return normalizedAssets;

    const primaryIndex = normalizedAssets.findIndex((asset) => asset.url === primaryImageUrl);
    if (primaryIndex <= 0) return normalizedAssets;

    return [
        normalizedAssets[primaryIndex],
        ...normalizedAssets.slice(0, primaryIndex),
        ...normalizedAssets.slice(primaryIndex + 1),
    ];
};

const buildVariableProductGallery = (variations = []) => {
    const variationAssets = (Array.isArray(variations) ? variations : [])
        .map((variation) => cloneImageAsset(variation.imageAsset || variation.image))
        .filter(Boolean);

    return promotePrimaryVariationAsset(variationAssets, variations).slice(0, MAX_PRODUCT_IMAGE_COUNT);
};

const collectProductImageAssets = (product) => {
    if (!product) return [];
    const galleryAssets = Array.isArray(product.imageAssets)
        ? product.imageAssets
        : (Array.isArray(product.images) ? product.images.map((url) => createImageAsset(url)) : []);

    const variationAssets = Array.isArray(product.variations)
        ? product.variations.map((variation) => variation?.imageAsset || variation?.image).filter(Boolean)
        : [];

    return dedupeAssets([...galleryAssets, ...variationAssets]);
};

const collectImageAssetsToDelete = ({ previousProduct, nextProduct }) => {
    const previousAssets = collectProductImageAssets(previousProduct);
    const nextAssets = collectProductImageAssets(nextProduct);
    const nextKeys = new Set(nextAssets.map((asset) => asset.publicId || asset.url));

    return previousAssets.filter((asset) => {
        const key = asset.publicId || asset.url;
        return key && !nextKeys.has(key);
    });
};

const deleteImageAssetBatch = async (assets = []) => {
    const uniqueAssets = dedupeAssets(assets);
    const results = await Promise.allSettled(uniqueAssets.map((asset) => deleteStoredImageAsset(asset)));
    return results
        .map((result, index) => ({ result, asset: uniqueAssets[index] }))
        .filter(({ result }) => result.status === 'rejected');
};

const mapExistingVariationAssets = (variations = []) => new Map(
    (Array.isArray(variations) ? variations : [])
        .map((variation) => {
            const asset = cloneImageAsset(variation?.imageAsset || variation?.image);
            if (!asset) return null;
            return [asset.url, asset];
        })
        .filter(Boolean),
);

const assignVariationImageAssets = ({
    variations = [],
    uploadedAssets = [],
    variationImageIndexes = [],
    existingVariationAssets = [],
}) => {
    const existingAssetMap = mapExistingVariationAssets(existingVariationAssets);
    const nextVariations = (Array.isArray(variations) ? variations : []).map((variation) => cloneVariation(variation));

    uploadedAssets.forEach((asset, index) => {
        const targetIndex = Number.isInteger(variationImageIndexes[index]) ? variationImageIndexes[index] : index;
        if (!nextVariations[targetIndex]) return;
        nextVariations[targetIndex].image = asset.url;
        nextVariations[targetIndex].imageAsset = { ...asset };
    });

    return nextVariations.map((variation) => {
        if (!variation.image) {
            delete variation.imageAsset;
            return variation;
        }

        if (!variation.imageAsset) {
            const existingAsset = existingAssetMap.get(variation.image);
            variation.imageAsset = existingAsset ? { ...existingAsset } : createImageAsset(variation.image);
        }

        return variation;
    });
};

const uploadProductFileBatch = async ({
    files = [],
    vendorId,
    publicIdPrefix,
    context,
}) => Promise.all(
    (Array.isArray(files) ? files : []).map(async (file, index) => {
        const uploadResult = await uploadBufferImage({
            buffer: file.buffer,
            folder: buildProductImageFolder(vendorId),
            publicIdPrefix: `${publicIdPrefix}-${index + 1}`,
            mimetype: file.mimetype,
            context,
        });

        return createImageAsset(uploadResult);
    }),
);

module.exports = {
    MAX_PRODUCT_IMAGE_COUNT,
    assignVariationImageAssets,
    buildProductImageFolder,
    buildVariableProductGallery,
    cloneVariation,
    collectImageAssetsToDelete,
    collectProductImageAssets,
    deleteImageAssetBatch,
    orderProductAssets,
    promotePrimaryVariationAsset,
    resolveSubmittedAssetsFromUrls,
    uploadProductFileBatch,
};
