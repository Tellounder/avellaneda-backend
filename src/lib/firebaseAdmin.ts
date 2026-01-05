import admin from 'firebase-admin';

const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

const hasCredentials = Boolean(projectId && clientEmail && privateKey);

if (!admin.apps.length && hasCredentials) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey,
    }),
  });
}

export const firebaseReady = hasCredentials;
export const firebaseAuth = admin.apps.length ? admin.auth() : null;
