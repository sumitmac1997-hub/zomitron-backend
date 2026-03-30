const admin = require('firebase-admin');

let firebaseApp;

const getFirebaseAdminConfig = () => {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (!projectId || !clientEmail || !privateKey) {
        return null;
    }

    return {
        credential: admin.credential.cert({
            projectId,
            clientEmail,
            privateKey,
        }),
    };
};

const isFirebaseAdminConfigured = () => Boolean(getFirebaseAdminConfig());

const getFirebaseAdminApp = () => {
    if (firebaseApp) return firebaseApp;

    const config = getFirebaseAdminConfig();
    if (!config) {
        throw new Error('Firebase Admin is not configured');
    }

    firebaseApp = admin.apps.length ? admin.app() : admin.initializeApp(config);
    return firebaseApp;
};

const verifyFirebaseIdToken = async (idToken) => {
    if (!idToken) {
        throw new Error('Firebase ID token is required');
    }

    const app = getFirebaseAdminApp();
    return admin.auth(app).verifyIdToken(idToken, true);
};

module.exports = {
    getFirebaseAdminApp,
    isFirebaseAdminConfigured,
    verifyFirebaseIdToken,
};
