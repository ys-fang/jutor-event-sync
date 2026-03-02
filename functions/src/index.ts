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
    if (!uid || typeof uid !== 'string') {
      res.status(400).json({ error: 'uid is required' });
      return;
    }

    try {
      const token = await admin.auth().createCustomToken(uid);
      res.status(200).json({ token });
    } catch (error) {
      res.status(500).json({ error: 'Failed to create token' });
    }
  }
);
