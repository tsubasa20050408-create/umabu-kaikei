import { CORRECT_PIN, makeToken } from './_lib.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  const { pin } = req.body || {};
  if (!pin || typeof pin !== 'string') return res.status(400).json({ error: 'pin_required' });
  if (pin.trim() !== CORRECT_PIN) return res.status(401).json({ error: 'invalid_pin' });

  return res.status(200).json({ token: makeToken(), expiresIn: 604800 });
}
