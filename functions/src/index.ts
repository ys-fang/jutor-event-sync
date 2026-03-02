import * as admin from 'firebase-admin';
import { onRequest } from 'firebase-functions/v2/https';

admin.initializeApp();

export const mintToken = onRequest(
  {
    cors: ['https://jutor.ai', 'https://www.jutor.ai'],
    region: 'asia-east1',
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const { uid } = req.body;
    if (!uid || typeof uid !== 'string' || uid.trim().length === 0 || uid.length > 128) {
      res.status(400).json({ error: 'uid is required and must be 1-128 characters' });
      return;
    }

    try {
      const token = await admin.auth().createCustomToken(uid);
      res.status(200).json({ token });
    } catch (error) {
      console.error('createCustomToken failed:', error);
      res.status(500).json({ error: 'Failed to create token' });
    }
  }
);
